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
 * Process-wide event bus so whatever embeds the daemon (the menu-bar app, or
 * the CLI) can observe it without the daemon knowing about them. Each posts
 * the desktop notification for a new question from its own "query" listener.
 * Events: "state" (DaemonState), "query" (QueryEvent).
 */
export const daemonEvents = new EventEmitter();
