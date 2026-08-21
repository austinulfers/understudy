import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import {
  BrokerToDaemonSchema,
  DaemonToBrokerSchema,
  parseFrame,
  type BrokerToDaemon,
  type DaemonToBroker,
} from "@workspace-agent/shared";
import { touchHost, verifyDevice } from "./db";
import { config } from "./config";

interface Conn {
  ws: WebSocket;
  hostId: string;
  paused: boolean;
  alive: boolean;
}

export interface QueryHandlers {
  onStatus: (note: string) => void;
  onPartial: (text: string) => void;
  onResult: (result: Extract<DaemonToBroker, { type: "result" }>) => void;
}

interface Pending extends QueryHandlers {
  hostId: string;
  timer: NodeJS.Timeout;
}

/**
 * Registry of live daemon connections. Daemons dial out to /ws and
 * authenticate at upgrade time; the broker never connects inward.
 */
export class Hub {
  private conns = new Map<string, Conn>();
  private pending = new Map<string, Pending>();

  attach(server: Server): void {
    const wss = new WebSocketServer({ noServer: true });

    server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== "/ws") {
        socket.destroy();
        return;
      }
      const deviceId = String(req.headers["x-device-id"] ?? "");
      const deviceSecret = String(req.headers["x-device-secret"] ?? "");
      const host = deviceId && deviceSecret ? verifyDevice(deviceId, deviceSecret) : null;
      if (!host) {
        // Must be a well-formed response with a length, or proxies in front of
        // the broker (cloudflared) turn the aborted socket into a 502.
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        socket.end();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        this.register(host.id, ws);
      });
    });

    setInterval(() => {
      for (const conn of this.conns.values()) {
        if (!conn.alive) {
          conn.ws.terminate();
          continue;
        }
        conn.alive = false;
        conn.ws.ping();
        touchHost(conn.hostId);
      }
    }, 30_000).unref();
  }

  private register(hostId: string, ws: WebSocket): void {
    this.conns.get(hostId)?.ws.close(4000, "replaced by a newer connection");
    const conn: Conn = { ws, hostId, paused: false, alive: true };
    this.conns.set(hostId, conn);
    touchHost(hostId);
    console.log(`[hub] host ${hostId} connected`);

    ws.on("pong", () => {
      conn.alive = true;
    });

    ws.on("message", (raw) => {
      const msg = parseFrame(DaemonToBrokerSchema, raw.toString());
      if (!msg) return;
      touchHost(hostId);
      if (msg.type === "presence") {
        conn.paused = msg.paused;
        return;
      }
      const pending = this.pending.get(msg.queryId);
      if (!pending || pending.hostId !== hostId) return;
      if (msg.type === "status") pending.onStatus(msg.note);
      else if (msg.type === "partial") pending.onPartial(msg.text);
      else if (msg.type === "result") this.settle(msg.queryId, msg);
    });

    ws.on("close", () => {
      if (this.conns.get(hostId) === conn) this.conns.delete(hostId);
      touchHost(hostId);
      console.log(`[hub] host ${hostId} disconnected`);
      for (const [queryId, pending] of this.pending) {
        if (pending.hostId === hostId) {
          this.settle(queryId, {
            type: "result",
            queryId,
            ok: false,
            error: "The host went offline mid-answer.",
          });
        }
      }
    });
  }

  /** Instantly severs a revoked host's connection. */
  disconnect(hostId: string): void {
    this.conns.get(hostId)?.ws.close(4001, "access revoked");
    this.conns.delete(hostId);
  }

  isOnline(hostId: string): boolean {
    return this.conns.has(hostId);
  }

  isPaused(hostId: string): boolean {
    return this.conns.get(hostId)?.paused ?? false;
  }

  dispatch(
    hostId: string,
    query: Omit<Extract<BrokerToDaemon, { type: "query" }>, "type" | "queryId">,
    handlers: QueryHandlers,
  ): string | null {
    const conn = this.conns.get(hostId);
    if (!conn) return null;
    const queryId = randomUUID();
    const timer = setTimeout(() => {
      this.send(conn, { type: "cancel", queryId });
      this.settle(queryId, {
        type: "result",
        queryId,
        ok: false,
        error: `Timed out after ${Math.round(config.queryTimeoutMs / 60000)} minutes.`,
      });
    }, config.queryTimeoutMs);
    timer.unref();
    this.pending.set(queryId, { ...handlers, hostId, timer });
    this.send(conn, { type: "query", queryId, ...query });
    return queryId;
  }

  private settle(queryId: string, result: Extract<DaemonToBroker, { type: "result" }>): void {
    const pending = this.pending.get(queryId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(queryId);
    pending.onResult(result);
  }

  private send(conn: Conn, msg: BrokerToDaemon): void {
    BrokerToDaemonSchema.parse(msg);
    conn.ws.send(JSON.stringify(msg));
  }
}

export const hub = new Hub();
