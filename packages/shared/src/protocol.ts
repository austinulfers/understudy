import { z } from "zod";

/**
 * Wire protocol between the broker and host daemons.
 * All frames are JSON text messages over a single WebSocket.
 * Daemons authenticate at upgrade time via x-device-id / x-device-secret
 * headers; no auth frames exist in the protocol itself.
 *
 * Fields added after the first release carry defaults so a daemon and a
 * broker on different versions keep talking: unknown fields are dropped,
 * missing ones filled in, and frames of an unknown type are ignored.
 */

/** Another host's agent, as described to the one answering a question. */
export const PeerInfoSchema = z.object({
  name: z.string(),
  online: z.boolean(),
  paused: z.boolean(),
  /** Basenames of the directories that agent exposes, e.g. ["acme-api"]. */
  folders: z.array(z.string()),
  /** False when its owner switched off questions from other agents. */
  consultable: z.boolean().default(true),
});
export type PeerInfo = z.infer<typeof PeerInfoSchema>;

export const BrokerToDaemonSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("query"),
    queryId: z.string(),
    /** Stable key for the Slack conversation this query belongs to. */
    threadKey: z.string(),
    question: z.string(),
    askerId: z.string(),
    askerName: z.string(),
    /** SDK session to resume for follow-ups; null for a fresh session. */
    resumeSessionId: z.string().nullable(),
    /** 0 when a person asked; 1 when another host's agent asked on their behalf. */
    depth: z.number().int().min(0).default(0),
    /** Name of the host whose agent is asking, when depth > 0. */
    viaHost: z.string().nullable().default(null),
    /**
     * Other agents the asker may reach, so the answering agent knows they
     * exist. Advisory only: the broker re-checks access on every ask.
     */
    peers: z.array(PeerInfoSchema).default([]),
    /** How many of those agents this session may consult; 0 withholds the tool. */
    peerAskLimit: z.number().int().min(0).default(0),
  }),
  z.object({
    type: z.literal("cancel"),
    queryId: z.string(),
  }),
  z.object({
    /** Answer to an earlier ask_peer, delivered to the session that asked. */
    type: z.literal("peer_result"),
    queryId: z.string(),
    requestId: z.string(),
    hostName: z.string(),
    ok: z.boolean(),
    text: z.string().optional(),
    error: z.string().optional(),
  }),
]);
export type BrokerToDaemon = z.infer<typeof BrokerToDaemonSchema>;

export const DaemonToBrokerSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("presence"),
    paused: z.boolean(),
    /** Basenames of the exposed roots, shown to askers and to other agents. */
    folders: z.array(z.string()).default([]),
  }),
  z.object({
    type: z.literal("status"),
    queryId: z.string(),
    /** Short human-readable progress note, e.g. "reading src/auth.ts". */
    note: z.string(),
  }),
  z.object({
    type: z.literal("partial"),
    queryId: z.string(),
    /** Cumulative answer text so far (not a delta). */
    text: z.string(),
  }),
  z.object({
    /** The session answering `queryId` wants another host's agent to answer `question`. */
    type: z.literal("ask_peer"),
    queryId: z.string(),
    /** Daemon-chosen id, echoed back on the matching peer_result. */
    requestId: z.string(),
    hostName: z.string(),
    question: z.string(),
  }),
  z.object({
    type: z.literal("result"),
    queryId: z.string(),
    ok: z.boolean(),
    text: z.string().optional(),
    error: z.string().optional(),
    sessionId: z.string().optional(),
    turns: z.number().optional(),
    costUsd: z.number().optional(),
  }),
]);
export type DaemonToBroker = z.infer<typeof DaemonToBrokerSchema>;

export function parseFrame<T>(schema: z.ZodType<T>, raw: unknown): T | null {
  if (typeof raw !== "string" && !(raw instanceof Buffer)) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(raw.toString()));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
