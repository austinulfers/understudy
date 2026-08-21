import { App } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import { config } from "./config";
import {
  addAcl,
  bindThread,
  clearDmHost,
  clearThread,
  getDmHost,
  getHostById,
  getHostByName,
  getThread,
  hostsForUser,
  hostsOwnedBy,
  listAclsDetailed,
  removeAcl,
  setDmHost,
  type HostRow,
} from "./db";
import { formatLastSeen } from "./format";
import { hub } from "./hub";
import { isAdmin, preflight, runQuery } from "./router";

// deferInitialization: constructing the App must not touch the network —
// the HTTP layer imports this module in contexts where Slack isn't live
// (offline smoke tests); auth happens in startSlack().
export const app = new App({
  token: config.slackBotToken,
  appToken: config.slackAppToken,
  socketMode: true,
  deferInitialization: true,
});

let botUserId = "";
const nameCache = new Map<string, string>();

async function displayName(client: WebClient, userId: string): Promise<string> {
  const cached = nameCache.get(userId);
  if (cached) return cached;
  try {
    const res = await client.users.info({ user: userId });
    const name = res.user?.profile?.display_name || res.user?.real_name || userId;
    nameCache.set(userId, name);
    return name;
  } catch {
    return userId;
  }
}

function stripMention(text: string): string {
  return text.replaceAll(new RegExp(`<@${botUserId}>`, "g"), "").trim();
}

/**
 * Pull an explicit target host off the front of a question:
 * "jane: where is X", "jane, where is X", or "ask jane where is X".
 * Only matches when the leading token is a real enrolled host, so
 * questions that merely start with a name-like word pass through.
 */
function parseTarget(text: string): { host: HostRow; question: string } | null {
  const patterns = [
    /^ask\s+([\w.-]+)[:,]?\s+(.+)$/is,
    /^([\w.-]+)[:,]\s*(.+)$/s,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m && m[1] && m[2]) {
      const host = getHostByName(m[1]);
      if (host) return { host, question: m[2].trim() };
    }
  }
  return null;
}

function hostLine(host: HostRow): string {
  const status = hub.isOnline(host.id)
    ? hub.isPaused(host.id)
      ? "⏸ paused"
      : "🟢 online"
    : `⚫ offline (${formatLastSeen(host.last_seen)})`;
  return `• *${host.name}* — ${status}`;
}

function helpText(userId: string): string {
  const hosts = hostsForUser(userId, isAdmin(userId));
  const list = hosts.length
    ? hosts.map(hostLine).join("\n")
    : "_You don't have access to any agents yet — ask the admin._";
  return [
    "Ask a coworker's read-only Claude a question about the code on their machine.",
    "",
    "*In a channel:* `/ask jane where does token refresh happen?` or mention me: `@Workspace Agent jane: …`",
    "*In this DM:* `jane: your question` — after that, just keep typing and I'll keep asking jane.",
    "*DM commands:* `hosts` (list agents), `reset` (forget the current agent + conversation), `help`",
    "*If you own an agent:* `allow @name` / `deny @name` control who may ask it; `team` shows who has access.",
    "",
    "*Agents you can ask:*",
    list,
  ].join("\n");
}

async function postPlaceholder(client: WebClient, channel: string, threadTs?: string): Promise<string | null> {
  try {
    const res = await client.chat.postMessage({ channel, thread_ts: threadTs, text: "_⏳ asking the agent…_" });
    return (res.ts as string) ?? null;
  } catch {
    return null;
  }
}

/** Shared endgame for every surface once host + question are known. */
async function ask(opts: {
  client: WebClient;
  host: HostRow;
  askerId: string;
  question: string;
  channel: string;
  /** Existing thread root to answer under; undefined = top-level DM reply. */
  threadTs?: string;
  threadKey: string;
  refuse: (message: string) => Promise<unknown>;
}): Promise<void> {
  const { client, host, askerId, question, channel, threadTs, threadKey, refuse } = opts;
  const refusal = preflight(host, askerId);
  if (refusal) {
    await refuse(refusal);
    return;
  }
  bindThread(threadKey, host.id, askerId);
  const placeholderTs = await postPlaceholder(client, channel, threadTs);
  if (!placeholderTs) return;
  runQuery({
    client,
    host,
    askerId,
    askerName: await displayName(client, askerId),
    question,
    channel,
    placeholderTs,
    threadTs,
    threadKey,
  });
}

// --- /ask slash command (works in channels and in the bot DM) ---

app.command("/ask", async ({ command, ack, respond, client }) => {
  await ack();
  const target = parseTarget(command.text.trim());
  if (!target) {
    await respond({ response_type: "ephemeral", text: helpText(command.user_id) });
    return;
  }
  const refusal = preflight(target.host, command.user_id);
  if (refusal) {
    await respond({ response_type: "ephemeral", text: refusal });
    return;
  }
  // Banner message becomes the thread root the answer lives under.
  let bannerTs: string | null = null;
  try {
    const banner = await client.chat.postMessage({
      channel: command.channel_id,
      text: `❓ <@${command.user_id}> → *${target.host.name}*\n> ${target.question.slice(0, 500)}`,
    });
    bannerTs = (banner.ts as string) ?? null;
  } catch {
    await respond({
      response_type: "ephemeral",
      text: "I can't post here — `/invite @Workspace Agent` to this channel first, or DM me instead.",
    });
    return;
  }
  if (!bannerTs) return;
  await ask({
    client,
    host: target.host,
    askerId: command.user_id,
    question: target.question,
    channel: command.channel_id,
    threadTs: bannerTs,
    threadKey: `${command.channel_id}:${bannerTs}`,
    refuse: (text) => respond({ response_type: "ephemeral", text }),
  });
});

// --- @mentions in channels ---

app.event("app_mention", async ({ event, client }) => {
  // DMs are handled by the message listener below.
  if (event.channel.startsWith("D")) return;
  const text = stripMention(event.text ?? "");
  const rootTs = event.thread_ts ?? event.ts;
  const threadKey = `${event.channel}:${rootTs}`;
  const askerId = event.user;
  if (!askerId) return;

  const reply = (t: string) =>
    client.chat.postMessage({ channel: event.channel, thread_ts: rootTs, text: t });

  // Mention inside a thread that's already bound to a host = follow-up.
  const bound = getThread(threadKey);
  if (bound && event.thread_ts) {
    const host = getHostById(bound.host_id);
    if (!host || host.status !== "active") {
      await reply("This agent has been unenrolled.");
      return;
    }
    await ask({ client, host, askerId, question: text, channel: event.channel, threadTs: rootTs, threadKey, refuse: reply });
    return;
  }

  const target = parseTarget(text);
  if (!target) {
    await reply(helpText(askerId));
    return;
  }
  await ask({
    client,
    host: target.host,
    askerId,
    question: target.question,
    channel: event.channel,
    threadTs: rootTs,
    threadKey,
    refuse: reply,
  });
});

// --- plain messages: DM surface + follow-ups in bound channel threads ---

app.event("message", async ({ event, client }) => {
  const msg = event as {
    subtype?: string;
    bot_id?: string;
    user?: string;
    text?: string;
    channel: string;
    channel_type?: string;
    ts: string;
    thread_ts?: string;
  };
  if (msg.subtype || msg.bot_id || !msg.user || !msg.text) return;
  // Mentions are handled by the app_mention listener (channels only).
  if (msg.channel_type !== "im" && msg.text.includes(`<@${botUserId}>`)) return;

  if (msg.channel_type === "im") {
    await handleDm(client, msg as { user: string; text: string; channel: string; ts: string; thread_ts?: string });
    return;
  }

  // In channels, only react to replies inside threads we own.
  if (!msg.thread_ts || msg.thread_ts === msg.ts) return;
  const threadKey = `${msg.channel}:${msg.thread_ts}`;
  const bound = getThread(threadKey);
  if (!bound) return;
  const host = getHostById(bound.host_id);
  if (!host || host.status !== "active") return;
  await ask({
    client,
    host,
    askerId: msg.user,
    question: msg.text,
    channel: msg.channel,
    threadTs: msg.thread_ts,
    threadKey,
    refuse: (t) => client.chat.postMessage({ channel: msg.channel, thread_ts: msg.thread_ts, text: t }),
  });
});

async function handleDm(
  client: WebClient,
  msg: { user: string; text: string; channel: string; ts: string; thread_ts?: string },
): Promise<void> {
  const text = stripMention(msg.text).trim();
  const say = (t: string) => client.chat.postMessage({ channel: msg.channel, text: t });

  // Follow-up inside a DM thread we already own.
  if (msg.thread_ts && msg.thread_ts !== msg.ts) {
    const threadKey = `${msg.channel}:${msg.thread_ts}`;
    const bound = getThread(threadKey);
    if (bound) {
      const host = getHostById(bound.host_id);
      if (host && host.status === "active") {
        await ask({
          client,
          host,
          askerId: msg.user,
          question: text,
          channel: msg.channel,
          threadTs: msg.thread_ts,
          threadKey,
          refuse: (t) => client.chat.postMessage({ channel: msg.channel, thread_ts: msg.thread_ts, text: t }),
        });
      }
      return;
    }
  }

  const lower = text.toLowerCase();
  if (lower === "help" || lower === "") {
    await say(helpText(msg.user));
    return;
  }
  const firstWord = lower.split(/\s+/)[0] ?? "";
  if (["allow", "deny", "revoke", "team"].includes(firstWord)) {
    await handleOwnerCommand(client, msg.user, firstWord === "revoke" ? "deny" : firstWord, text, say);
    return;
  }
  if (lower === "hosts" || lower === "agents") {
    const hosts = hostsForUser(msg.user, isAdmin(msg.user));
    await say(hosts.length ? hosts.map(hostLine).join("\n") : "You don't have access to any agents yet.");
    return;
  }
  if (lower === "reset") {
    const sticky = getDmHost(msg.channel);
    if (sticky) clearThread(`dm:${msg.channel}:${sticky}`);
    clearDmHost(msg.channel);
    await say("Forgotten. Name an agent to start fresh, e.g. `jane: where is the retry logic?`");
    return;
  }

  // Explicit target ("jane: …" / "ask jane …") wins and becomes sticky.
  const target = parseTarget(text);
  let host: HostRow | undefined;
  let question: string;
  if (target) {
    host = target.host;
    question = target.question;
    setDmHost(msg.channel, host.id);
  } else {
    // No target named: fall back to this DM's sticky host.
    const stickyId = getDmHost(msg.channel);
    host = stickyId ? getHostById(stickyId) : undefined;
    if (host && host.status !== "active") host = undefined;
    question = text;
  }

  if (!host) {
    await say(helpText(msg.user));
    return;
  }

  // Top-level DM flow: one rolling session per (DM, host); answers post
  // top-level so the conversation feels like a normal chat.
  const threadKey = `dm:${msg.channel}:${host.id}`;
  await ask({
    client,
    host,
    askerId: msg.user,
    question,
    channel: msg.channel,
    threadTs: undefined,
    threadKey,
    refuse: say,
  });

  if (config.breadcrumbChannel && !isAdmin(msg.user)) {
    client.chat
      .postMessage({
        channel: config.breadcrumbChannel,
        text: `🛰️ <@${msg.user}> asked *${host.name}*'s agent a question (via DM).`,
      })
      .catch(() => {});
  }
}

/**
 * Self-service permissions: the owner of an enrolled agent grants and
 * revokes access to it from their DM with the bot. Applies to every
 * active host they own (usually one machine).
 */
async function handleOwnerCommand(
  client: WebClient,
  ownerId: string,
  cmd: string,
  text: string,
  say: (t: string) => Promise<unknown>,
): Promise<void> {
  const owned = hostsOwnedBy(ownerId);
  if (!owned.length) {
    await say("These commands manage who can ask *your* agent, but this Slack account doesn't own an enrolled agent.");
    return;
  }

  if (cmd === "team") {
    const sections: string[] = [];
    for (const host of owned) {
      const entries = await Promise.all(
        listAclsDetailed(host.id).map(async (row) => {
          const name = await displayName(client, row.slack_user_id);
          const via =
            row.slack_user_id === host.owner_slack_id
              ? "owner"
              : row.granted_by === "admin"
                ? "granted by admin"
                : row.granted_by
                  ? `added by ${await displayName(client, row.granted_by)}`
                  : "";
          return `  • ${name}${via ? ` — _${via}_` : ""}`;
        }),
      );
      sections.push(`*${host.name}* can be asked by:\n${entries.join("\n")}`);
    }
    sections.push("_Admins can always ask. `allow @name` / `deny @name` to change this._");
    await say(sections.join("\n\n"));
    return;
  }

  const targets = [...text.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]+)?>/g)].map((m) => m[1]!);
  if (!targets.length) {
    await say(`Usage: \`${cmd} @coworker\` — mention the people to ${cmd === "allow" ? "grant access" : "remove"}.`);
    return;
  }

  const results: string[] = [];
  for (const target of [...new Set(targets)]) {
    for (const host of owned) {
      if (cmd === "allow") {
        addAcl(host.id, target, ownerId);
        results.push(`✅ <@${target}> can now ask *${host.name}*.`);
        // Courtesy heads-up doubling as onboarding; needs the im:write scope.
        client.chat
          .postMessage({
            channel: target,
            text: `<@${ownerId}> shared their code agent *${host.name}* with you. Try \`/ask ${host.name} <question>\` in a channel, or DM me \`${host.name}: <question>\`.`,
          })
          .catch(() => {});
      } else if (target === host.owner_slack_id) {
        results.push(`You always keep access to *${host.name}* — skipped removing yourself.`);
      } else {
        removeAcl(host.id, target);
        results.push(`🚫 <@${target}> can no longer ask *${host.name}*.`);
      }
    }
  }
  await say(results.join("\n"));
}

/** Name lookup for the HTTP layer (device-authed app API). */
export function lookupDisplayName(userId: string): Promise<string> {
  return displayName(app.client, userId);
}

let userDirectory: { at: number; users: { id: string; name: string }[] } | null = null;

/** Workspace user search for the app's people picker (10-minute cache). */
export async function searchWorkspaceUsers(query: string): Promise<{ id: string; name: string }[]> {
  if (!userDirectory || Date.now() - userDirectory.at > 10 * 60_000) {
    const users: { id: string; name: string }[] = [];
    let cursor: string | undefined;
    do {
      const res = await app.client.users.list({ limit: 200, cursor });
      for (const member of res.members ?? []) {
        if (member.deleted || member.is_bot || member.id === "USLACKBOT" || !member.id) continue;
        users.push({
          id: member.id,
          name: member.profile?.display_name || member.real_name || member.name || member.id,
        });
      }
      cursor = res.response_metadata?.next_cursor || undefined;
    } while (cursor);
    userDirectory = { at: Date.now(), users };
  }
  const needle = query.trim().toLowerCase();
  return userDirectory.users.filter((u) => u.name.toLowerCase().includes(needle)).slice(0, 10);
}

export async function startSlack(): Promise<void> {
  await app.init();
  await app.start();
  const auth = await app.client.auth.test({ token: config.slackBotToken });
  botUserId = (auth.user_id as string) ?? "";
  console.log(`[slack] connected as ${auth.user} (${botUserId})`);
}
