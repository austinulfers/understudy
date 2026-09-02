import type { WebClient } from "@slack/web-api";
import { redactSecrets, type PeerInfo } from "@workspace-agent/shared";
import { config } from "./config";
import {
  addTranscript,
  bindThread,
  bumpUsage,
  getHostByName,
  getThread,
  hasAcl,
  hostsForUser,
  setThreadSession,
  usageToday,
  type HostRow,
} from "./db";
import { chunkForSlack, formatLastSeen, mdToMrkdwn } from "./format";
import { hub, type PeerAsk, type PeerReply } from "./hub";

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

export interface PreflightOptions {
  /**
   * Skip the per-asker rate limit. Questions one agent asks another on the
   * asker's behalf are capped per question instead, so they never lock the
   * person out of asking their own next question.
   */
  skipRateLimit?: boolean;
}

/**
 * All the reasons a query is refused, checked in order. Returns a
 * user-facing message, or null when the query may proceed.
 */
export function preflight(host: HostRow, askerId: string, opts: PreflightOptions = {}): string | null {
  if (!isAdmin(askerId) && !hasAcl(host.id, askerId)) {
    return `You don't have access to *${host.name}*'s agent. Ask the admin to grant it.`;
  }
  if (!opts.skipRateLimit && rateLimited(askerId)) {
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

/** Slack mrkdwn → plain text, for messages that go to a model instead. */
function plain(mrkdwn: string): string {
  return mrkdwn.replace(/\*/g, "");
}

/**
 * The other agents an asker may reach, as the answering agent will hear
 * about them. Excludes the answering host itself.
 */
export function peersFor(askerId: string, excludeHostId: string): PeerInfo[] {
  return hostsForUser(askerId, isAdmin(askerId))
    .filter((h) => h.id !== excludeHostId)
    .map((h) => ({
      name: h.name,
      online: hub.isOnline(h.id),
      paused: hub.isPaused(h.id),
      folders: hub.foldersOf(h.id),
      consultable: h.accept_peer_asks === 1,
    }));
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
  /** Agents this answer consulted, in order; also the per-question fan-out count. */
  const consulted: string[] = [];

  const dispatched = hub.dispatch(
    host.id,
    {
      threadKey,
      question,
      askerId,
      askerName,
      resumeSessionId,
      depth: 0,
      viaHost: null,
      peers: peersFor(askerId, host.id),
      peerAskLimit: config.peerAsksPerQuery,
    },
    {
      onStatus: (note) => stream.push(`_${note}_`),
      onPartial: (text) => stream.push(mdToMrkdwn(redactSecrets(text).text)),
      onAskPeer: (ask, reply) => {
        if (consulted.length >= config.peerAsksPerQuery) {
          reply({
            ok: false,
            error: `This question has already used its ${config.peerAsksPerQuery} consultation(s) of other agents.`,
          });
          return;
        }
        stream.push(`_asking ${ask.hostName}'s agent…_`);
        const target = runPeerQuery(
          { source: host, askerId, askerName, threadKey, parentQueryId: ask.fromQueryId },
          ask,
          reply,
        );
        if (target) consulted.push(target.name);
      },
      onResult: (result) => {
        void (async () => {
          if (result.ok && result.text !== undefined) {
            const { text: safe, hits } = redactSecrets(result.text);
            const notes: string[] = [];
            if (consulted.length) {
              const names = [...new Set(consulted)].map((n) => `${n}'s agent`).join(", ");
              notes.push(`🤝 Consulted ${names}.`);
            }
            if (hits > 0) notes.push(`🔒 ${hits} secret-looking string(s) redacted.`);
            const suffix = notes.length ? `\n\n_${notes.join(" ")}_` : "";
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

interface PeerAskSource {
  /** The host whose session is asking. */
  source: HostRow;
  /** The person whose question started all this; access is checked as them. */
  askerId: string;
  askerName: string;
  /** Conversation the asking session belongs to. */
  threadKey: string;
  parentQueryId: string;
}

/**
 * Routes a question one agent asks another. Every check a person's own
 * question would face applies to the original asker — access, the target's
 * budget, presence — so a hop between agents never reaches code the asker
 * couldn't have asked about directly. Returns the target once dispatched.
 */
export function runPeerQuery(src: PeerAskSource, ask: PeerAsk, reply: PeerReply): HostRow | null {
  const target = getHostByName(ask.hostName);
  if (!target) {
    reply({ ok: false, error: `There is no agent named "${ask.hostName}".` });
    return null;
  }
  if (target.id === src.source.id) {
    reply({ ok: false, error: "That is this agent; it can't ask itself." });
    return null;
  }
  if (target.accept_peer_asks !== 1) {
    reply({
      ok: false,
      error: `${target.name}'s agent doesn't take questions from other agents. ${src.askerName} can ask it directly.`,
    });
    return null;
  }
  const refusal = preflight(target, src.askerId, { skipRateLimit: true });
  if (refusal) {
    reply({ ok: false, error: plain(refusal) });
    return null;
  }

  // One rolling sub-conversation per (conversation, consulted host): a
  // second question to the same agent resumes its session, and its owner
  // sees the exchange as one conversation on their machine.
  const childKey = `${src.threadKey}>${target.id}`;
  const firstContact = !getThread(childKey);
  bindThread(childKey, target.id, src.askerId);
  if (firstContact) {
    addTranscript(
      childKey,
      target.id,
      src.askerId,
      "system",
      `🤝 ${src.source.name}'s agent is asking on behalf of ${src.askerName}.`,
    );
  }
  addTranscript(childKey, target.id, src.askerId, "user", ask.question);
  addTranscript(src.threadKey, src.source.id, src.askerId, "system", `🤝 Asked ${target.name}'s agent: ${ask.question}`);
  bumpUsage(target.id);

  const queryId = hub.dispatch(
    target.id,
    {
      threadKey: childKey,
      question: ask.question,
      askerId: src.askerId,
      askerName: src.askerName,
      resumeSessionId: getThread(childKey)?.sdk_session_id ?? null,
      depth: 1,
      viaHost: src.source.name,
      // One hop only: a consulted agent gets no peers and no tool.
      peers: [],
      peerAskLimit: 0,
    },
    {
      onStatus: () => {},
      onPartial: () => {},
      onResult: (result) => {
        if (result.ok && result.text !== undefined) {
          const safe = redactSecrets(result.text).text;
          if (result.sessionId) setThreadSession(childKey, result.sessionId);
          addTranscript(childKey, target.id, src.askerId, "assistant", safe);
          addTranscript(src.threadKey, src.source.id, src.askerId, "system", `🤝 ${target.name}'s agent answered: ${safe}`);
          reply({ ok: true, text: safe });
        } else {
          const error = result.error ?? "The agent failed to answer.";
          addTranscript(childKey, target.id, src.askerId, "system", `⚠️ ${error}`);
          addTranscript(src.threadKey, src.source.id, src.askerId, "system", `⚠️ ${target.name}'s agent: ${error}`);
          reply({ ok: false, error });
        }
      },
    },
    { timeoutMs: config.peerQueryTimeoutMs, parentQueryId: src.parentQueryId },
  );
  if (!queryId) {
    // Preflight saw it online a moment ago; it dropped in between.
    reply({ ok: false, error: `${target.name}'s agent is offline (${formatLastSeen(target.last_seen)}).` });
    return null;
  }
  return target;
}
