import type { WebClient } from "@slack/web-api";
import { redactSecrets } from "@workspace-agent/shared";
import { config } from "./config";
import {
  addTranscript,
  bumpUsage,
  getThread,
  hasAcl,
  setThreadSession,
  usageToday,
  type HostRow,
} from "./db";
import { chunkForSlack, formatLastSeen, mdToMrkdwn } from "./format";
import { hub } from "./hub";

export function isAdmin(slackUserId: string): boolean {
  return config.adminSlackIds.includes(slackUserId);
}

// --- per-asker rate limiting (in-memory sliding window) ---

const askerHistory = new Map<string, number[]>();

function rateLimited(askerId: string): boolean {
  const now = Date.now();
  const window = (askerHistory.get(askerId) ?? []).filter((t) => now - t < 60_000);
  if (window.length >= config.askerRatePerMinute) {
    askerHistory.set(askerId, window);
    return true;
  }
  window.push(now);
  askerHistory.set(askerId, window);
  return false;
}

/**
 * All the reasons a query is refused, checked in order. Returns a
 * user-facing message, or null when the query may proceed.
 */
export function preflight(host: HostRow, askerId: string): string | null {
  if (!isAdmin(askerId) && !hasAcl(host.id, askerId)) {
    return `You don't have access to *${host.name}*'s agent. Ask the admin to grant it.`;
  }
  if (rateLimited(askerId)) {
    return `Easy there — you're limited to ${config.askerRatePerMinute} questions per minute.`;
  }
  const limit = host.daily_limit ?? config.defaultDailyLimit;
  if (usageToday(host.id) >= limit) {
    return `*${host.name}*'s agent hit its daily budget of ${limit} queries. Try again tomorrow.`;
  }
  if (!hub.isOnline(host.id)) {
    return `*${host.name}*'s agent is offline (${formatLastSeen(host.last_seen)}).`;
  }
  if (hub.isPaused(host.id)) {
    return `*${host.name}* has paused their agent.`;
  }
  return null;
}

/**
 * Streams a growing answer into one Slack message via throttled edits,
 * staying safely under Slack's ~1 write/sec/channel limit.
 */
class SlackStream {
  private latest: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private done = false;

  constructor(
    private client: WebClient,
    private channel: string,
    private ts: string,
  ) {}

  push(text: string): void {
    this.latest = text;
    if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), 1500);
    }
  }

  private async flush(): Promise<void> {
    this.timer = null;
    if (this.done || this.latest === null) return;
    const preview = this.latest.slice(0, 3700) + "\n\n_⏳ still working…_";
    this.latest = null;
    try {
      await this.client.chat.update({ channel: this.channel, ts: this.ts, text: preview });
    } catch {
      // Non-fatal: the final update will retry.
    }
  }

  async finalize(text: string, threadTs?: string): Promise<void> {
    this.done = true;
    if (this.timer) clearTimeout(this.timer);
    const chunks = chunkForSlack(text);
    await this.client.chat.update({ channel: this.channel, ts: this.ts, text: chunks[0] ?? "(empty answer)" });
    for (const chunk of chunks.slice(1)) {
      await this.client.chat.postMessage({ channel: this.channel, text: chunk, thread_ts: threadTs });
    }
  }
}

export interface QueryContext {
  client: WebClient;
  host: HostRow;
  askerId: string;
  askerName: string;
  question: string;
  channel: string;
  /** ts of the placeholder message the answer streams into. */
  placeholderTs: string;
  /** Thread root for overflow chunks; undefined for top-level DM replies. */
  threadTs?: string;
  threadKey: string;
}

/** Dispatches one question to a host daemon and streams the answer back. */
export function runQuery(ctx: QueryContext): void {
  const { client, host, askerId, askerName, question, channel, placeholderTs, threadTs, threadKey } = ctx;

  addTranscript(threadKey, host.id, askerId, "user", question);
  bumpUsage(host.id);

  const resumeSessionId = getThread(threadKey)?.sdk_session_id ?? null;
  const stream = new SlackStream(client, channel, placeholderTs);

  const dispatched = hub.dispatch(
    host.id,
    { threadKey, question, askerId, askerName, resumeSessionId },
    {
      onStatus: (note) => stream.push(`_${note}_`),
      onPartial: (text) => stream.push(mdToMrkdwn(redactSecrets(text).text)),
      onResult: (result) => {
        void (async () => {
          if (result.ok && result.text !== undefined) {
            const { text: safe, hits } = redactSecrets(result.text);
            const suffix = hits > 0 ? `\n\n_🔒 ${hits} secret-looking string(s) redacted._` : "";
            await stream.finalize(mdToMrkdwn(safe) + suffix, threadTs);
            if (result.sessionId) setThreadSession(threadKey, result.sessionId);
            addTranscript(threadKey, host.id, askerId, "assistant", safe);
          } else {
            const message = `⚠️ ${result.error ?? "The agent failed to answer."}`;
            await stream.finalize(message, threadTs);
            addTranscript(threadKey, host.id, askerId, "system", message);
          }
        })().catch((err) => console.error("[router] failed to post result", err));
      },
    },
  );

  if (!dispatched) {
    void stream.finalize(`*${host.name}*'s agent is offline (${formatLastSeen(host.last_seen)}).`, threadTs);
  }
}
