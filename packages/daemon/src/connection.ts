import * as path from "node:path";
import WebSocket from "ws";
import { BrokerToDaemonSchema, parseFrame, type DaemonToBroker } from "@workspace-agent/shared";
import { loadConfig, type DaemonConfig } from "./config";
import { daemonEvents } from "./events";
import { cancelQuery, handleQuery, resolvePeerResult } from "./sessions";

export interface DaemonControl {
  stop(): void;
  /** Flip pause state immediately (also picked up from config within 5s). */
  setPaused(paused: boolean): void;
  /** Switch the answering model immediately; undefined restores the default. */
  setModel(model: string | undefined): void;
  isConnected(): boolean;
}

export interface DaemonHooks {
  /** Called when the broker revokes this device. Default: log and exit(1). */
  onRevoked?: () => void;
}

/**
 * Outbound-only connection to the broker with reconnect + backoff.
 * The daemon never listens on any port.
 */
export function runDaemon(initial: DaemonConfig, hooks: DaemonHooks = {}): DaemonControl {
  let config = initial;
  let ws: WebSocket | null = null;
  let backoffMs = 1000;
  let stopped = false;
  let connected = false;
  let reconnectTimer: NodeJS.Timeout | null = null;

  const send = (msg: DaemonToBroker): void => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  /**
   * What the broker, and through it askers and other agents, know about this
   * host: whether it answers, and the names (not paths) of what it shares.
   */
  const presence = (): DaemonToBroker => ({
    type: "presence",
    paused: config.paused,
    folders: config.roots.map((root) => path.basename(root)),
  });

  const connect = (): void => {
    if (stopped) return;
    daemonEvents.emit("state", "connecting");
    const url = config.brokerUrl.replace(/^http/, "ws").replace(/\/$/, "") + "/ws";
    ws = new WebSocket(url, {
      headers: { "x-device-id": config.deviceId, "x-device-secret": config.deviceSecret },
    });

    ws.on("open", () => {
      backoffMs = 1000;
      connected = true;
      console.log(`[daemon] connected to ${url} as "${config.hostName}"`);
      daemonEvents.emit("state", "connected");
      send(presence());
    });

    ws.on("message", (raw) => {
      const msg = parseFrame(BrokerToDaemonSchema, raw.toString());
      if (!msg) return;
      if (msg.type === "cancel") {
        cancelQuery(msg.queryId);
        return;
      }
      if (msg.type === "peer_result") {
        resolvePeerResult(msg);
        return;
      }
      if (config.paused) {
        send({ type: "result", queryId: msg.queryId, ok: false, error: "This agent is paused by its owner." });
        return;
      }
      handleQuery(config, msg, send);
    });

    ws.on("close", (code, reason) => {
      connected = false;
      if (code === 4001) {
        daemonEvents.emit("state", "revoked");
        if (hooks.onRevoked) {
          hooks.onRevoked();
          return;
        }
        console.error("[daemon] access revoked by the broker; exiting.");
        process.exit(1);
      }
      daemonEvents.emit("state", "disconnected");
      if (stopped) return;
      console.log(`[daemon] disconnected (${code} ${reason.toString()}); retrying in ${backoffMs / 1000}s`);
      reconnectTimer = setTimeout(connect, backoffMs);
      backoffMs = Math.min(backoffMs * 2, 30_000);
    });

    ws.on("error", (err) => {
      console.error(`[daemon] socket error: ${err.message}`);
      ws?.close();
    });
  };

  connect();

  // Pick up `pause` / `resume` / root edits made by the CLI or the app while running.
  const poll = setInterval(() => {
    const fresh = loadConfig();
    if (!fresh) return;
    const pausedChanged = fresh.paused !== config.paused;
    const rootsChanged = fresh.roots.join("\0") !== config.roots.join("\0");
    config = fresh;
    if (pausedChanged) console.log(`[daemon] ${config.paused ? "paused" : "resumed"} by owner`);
    if (pausedChanged || rootsChanged) send(presence());
  }, 5000);
  poll.unref();

  return {
    stop() {
      stopped = true;
      clearInterval(poll);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
      connected = false;
    },
    setPaused(paused) {
      config = { ...config, paused };
      send(presence());
    },
    setModel(model) {
      // In-flight queries keep the model they started with.
      config = { ...config, model };
    },
    isConnected: () => connected,
  };
}
