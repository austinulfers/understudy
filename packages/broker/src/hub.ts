import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import {
  BrokerToDaemonSchema,
  DaemonToBrokerSchema,
  parseFrame,
  type BrokerToDaemon,
  type DaemonToBroker,
} from "@understudy/shared";
import { touchHost, verifyDevice } from "./db";
import { config } from "./config";

interface Conn {
  ws: WebSocket;
  hostId: string;
  paused: boolean;
  /** Basenames of the roots the daemon exposes, from its presence frame. */
  folders: string[];
  alive: boolean;
}

/** A mid-answer request from one host's session to ask another host. */
export interface PeerAsk {
  /** The query whose session is asking. */
  fromQueryId: string;
  requestId: string;
  hostName: string;
  question: string;
}
export type PeerReply = (result: { ok: boolean; text?: string; error?: string }) => void;

export interface QueryHandlers {
  onStatus: (note: string) => void;
  onPartial: (text: string) => void;
  onResult: (result: Extract<DaemonToBroker, { type: "result" }>) => void;
  /** Absent means this query's session may not consult other agents. */
  onAskPeer?: (ask: PeerAsk, reply: PeerReply) => void;
}

export interface DispatchOptions {
  timeoutMs?: number;
  /** The query this one answers a sub-question for; cancelled along with it. */
  parentQueryId?: string;
}

interface Pending extends QueryHandlers {
  hostId: string;
  timer: NodeJS.Timeout;
  parentQueryId: string | null;
  children: Set<string>;
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
    const conn: Conn = { ws, hostId, paused: false, folders: [], alive: true };
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
        conn.folders = msg.folders;
        return;
      }
      const pending = this.pending.get(msg.queryId);
      if (!pending || pending.hostId !== hostId) return;
      if (msg.type === "status") pending.onStatus(msg.note);
      else if (msg.type === "partial") pending.onPartial(msg.text);
      else if (msg.type === "ask_peer") this.relayPeerAsk(pending, msg);
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

  /**
   * Hands a session's request to consult another agent to whoever dispatched
   * the query (the router owns the policy), and routes the answer back to the
   * session that asked.
   */
  private relayPeerAsk(pending: Pending, msg: Extract<DaemonToBroker, { type: "ask_peer" }>): void {
    const reply: PeerReply = (result) => {
      // The asking session may have finished meanwhile; then nobody is waiting.
      if (this.pending.get(msg.queryId) !== pending) return;
      const conn = this.conns.get(pending.hostId);
      if (!conn) return;
      this.send(conn, {
        type: "peer_result",
        queryId: msg.queryId,
        requestId: msg.requestId,
        hostName: msg.hostName,
        ...result,
      });
    };
    if (!pending.onAskPeer) {
      reply({ ok: false, error: "This session may not consult other agents." });
      return;
    }
    pending.onAskPeer(
      { fromQueryId: msg.queryId, requestId: msg.requestId, hostName: msg.hostName, question: msg.question },
      reply,
    );
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

  /** Folder basenames the host's daemon announced; empty when offline. */
  foldersOf(hostId: string): string[] {
    return this.conns.get(hostId)?.folders ?? [];
  }

  dispatch(
    hostId: string,
    query: Omit<Extract<BrokerToDaemon, { type: "query" }>, "type" | "queryId">,
    handlers: QueryHandlers,
    opts: DispatchOptions = {},
  ): string | null {
    const conn = this.conns.get(hostId);
    if (!conn) return null;
    const queryId = randomUUID();
    const timeoutMs = opts.timeoutMs ?? config.queryTimeoutMs;
    const timer = setTimeout(() => {
      this.cancel(queryId, `Timed out after ${Math.round(timeoutMs / 60000)} minutes.`);
    }, timeoutMs);
    timer.unref();
    const pending: Pending = {
      ...handlers,
      hostId,
      timer,
      parentQueryId: opts.parentQueryId ?? null,
      children: new Set(),
    };
    this.pending.set(queryId, pending);
    if (opts.parentQueryId) this.pending.get(opts.parentQueryId)?.children.add(queryId);
    this.send(conn, { type: "query", queryId, ...query });
    return queryId;
  }

  /** Tells the daemon to stop and settles the query with an error. */
  cancel(queryId: string, error: string): void {
    const pending = this.pending.get(queryId);
    if (!pending) return;
    const conn = this.conns.get(pending.hostId);
    if (conn) this.send(conn, { type: "cancel", queryId });
    this.settle(queryId, { type: "result", queryId, ok: false, error });
  }

  private settle(queryId: string, result: Extract<DaemonToBroker, { type: "result" }>): void {
    const pending = this.pending.get(queryId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(queryId);
    if (pending.parentQueryId) this.pending.get(pending.parentQueryId)?.children.delete(queryId);
    // Once a question is over, nobody is waiting for its consultations.
    for (const child of [...pending.children]) {
      this.cancel(child, "The question this was answering has ended.");
    }
    pending.onResult(result);
  }

  private send(conn: Conn, msg: BrokerToDaemon): void {
    BrokerToDaemonSchema.parse(msg);
    if (conn.ws.readyState === WebSocket.OPEN) conn.ws.send(JSON.stringify(msg));
  }
}

export const hub = new Hub();
