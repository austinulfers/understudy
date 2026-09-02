import { EventEmitter } from "node:events";

export type DaemonState = "connecting" | "connected" | "disconnected" | "revoked";

export interface QueryEvent {
  state: "start" | "done" | "error";
  queryId: string;
  askerName: string;
  /** Set when another host's agent asked on the asker's behalf. */
  viaHost?: string;
  question: string;
  at: number;
  costUsd?: number;
}

/**
 * Process-wide event bus so an embedding UI (the menu-bar app) can observe
 * the daemon without the daemon knowing about it. The CLI ignores it.
 * Events: "state" (DaemonState), "query" (QueryEvent).
 */
export const daemonEvents = new EventEmitter();
