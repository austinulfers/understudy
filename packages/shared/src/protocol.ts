import { z } from "zod";

/**
 * Wire protocol between the broker and host daemons.
 * All frames are JSON text messages over a single WebSocket.
 * Daemons authenticate at upgrade time via x-device-id / x-device-secret
 * headers; no auth frames exist in the protocol itself.
 */

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
  }),
  z.object({
    type: z.literal("cancel"),
    queryId: z.string(),
  }),
]);
export type BrokerToDaemon = z.infer<typeof BrokerToDaemonSchema>;

export const DaemonToBrokerSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("presence"),
    paused: z.boolean(),
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
