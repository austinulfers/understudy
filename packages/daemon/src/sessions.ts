import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import {
  checkPath,
  expandHome,
  extractToolPaths,
  redactSecrets,
  type BrokerToDaemon,
  type DaemonToBroker,
  type PeerInfo,
} from "@workspace-agent/shared";
import type { DaemonConfig } from "./config";
import { daemonEvents, type QueryEvent } from "./events";
import { logLocal } from "./log";
import { notifyOwner } from "./notify";

const READ_ONLY_TOOLS = ["Read", "Grep", "Glob"];
const QUERY_TIMEOUT_MS = Number(process.env.WA_QUERY_TIMEOUT_MS ?? 5 * 60 * 1000);
const MAX_TURNS = 40;

/**
 * Consulting other coworkers' agents happens through one in-process MCP
 * tool. The broker routes the question and applies the asker's access;
 * this side only decides whether to offer the tool at all.
 */
const PEER_SERVER = "workspace";
const ASK_TOOL = "ask_agent";
/** The tool's name as the model (and canUseTool) sees it. */
const ASK_TOOL_FULL = `mcp__${PEER_SERVER}__${ASK_TOOL}`;
/** A bit above the broker's own cap, so its more specific error arrives first. */
const PEER_WAIT_MS = Number(process.env.WA_PEER_TIMEOUT_MS ?? 3.5 * 60 * 1000);
/** Keeps one consultation from crowding out the session's own context. */
const MAX_PEER_ANSWER_CHARS = 12_000;

type QueryMsg = Extract<BrokerToDaemon, { type: "query" }>;
type PeerResultMsg = Extract<BrokerToDaemon, { type: "peer_result" }>;
type Send = (msg: DaemonToBroker) => void;

const BASE_PROMPT = `You are a read-only assistant answering a coworker's question about the code on this machine, on behalf of its owner. You can read, search, and list files, nothing else.

Guidelines:
- Answer the question directly and concisely; this is going into a Slack message.
- Cite file paths (with line numbers where useful) so the asker can look for themselves.
- If the answer isn't in the exposed code, say so plainly rather than guessing.
- Never quote the contents of anything that looks like a credential or secret.`;

function describePeer(peer: PeerInfo): string {
  const status = !peer.online ? "offline" : peer.paused ? "paused" : "online";
  const folders = peer.folders.length ? ` — folders: ${peer.folders.join(", ")}` : "";
  const optedOut = peer.consultable ? "" : " — not taking questions from agents; the asker would have to ask directly";
  return `- ${peer.name} (${status})${folders}${optedOut}`;
}

/**
 * The base prompt, plus what this session should know about other agents:
 * that it is one of them (depth > 0), or which ones the asker can reach and
 * whether it may consult them.
 */
function buildSystemPrompt(msg: QueryMsg, canAsk: boolean): string {
  const parts = [BASE_PROMPT];
  if (msg.depth > 0 && msg.viaHost) {
    parts.push(
      `This question comes from ${msg.viaHost}'s agent — another coworker's read-only agent — which is answering ${msg.askerName}'s question and needs something only the code here can tell it. Your answer goes straight back to that agent, not to a person: be precise and factual, cite paths, and keep it to a few paragraphs at most. You cannot consult other agents yourself.`,
    );
  } else if (msg.peers.length) {
    parts.push(
      `Other coworkers' agents\n${msg.askerName} can also ask these read-only agents, each covering different code on a different coworker's machine:\n${msg.peers.map(describePeer).join("\n")}`,
    );
    if (canAsk) {
      parts.push(
        `Use the ${ASK_TOOL} tool to ask one of them a specific, self-contained question when the answer likely lives in their code rather than here — the other side of an API this code talks to, a service this repo depends on, something you looked for here and could not find. They cannot see this conversation or this machine, so include the context they need (names, endpoints, what you already established), but never forward file contents or anything that looks like a secret. Don't ask them what you can find out yourself, and don't ask about code you can see here. Each consultation runs on that coworker's Claude budget, so you get at most ${msg.peerAskLimit} per question; offline or paused agents won't answer. When you use their answer, say which agent it came from.`,
      );
    } else {
      parts.push(
        `You cannot ask them yourself. If the answer likely lives in one of their folders, say so and suggest ${msg.askerName} ask that agent directly, e.g. "/ask <name> …".`,
      );
    }
  }
  return parts.join("\n\n");
}

/** Live queries by id, so a broker cancel frame can abort mid-flight. */
const inflight = new Map<string, AbortController>();

/**
 * One promise chain per conversation: follow-ups resume the same SDK
 * session, and resuming a session concurrently with itself corrupts it.
 */
const threadQueues = new Map<string, Promise<void>>();

/** Consultations waiting on the broker's peer_result, by requestId. */
const peerWaiters = new Map<string, (msg: PeerResultMsg) => void>();

export function cancelQuery(queryId: string): void {
  inflight.get(queryId)?.abort();
}

/** Hands another agent's answer to the consultation waiting for it. */
export function resolvePeerResult(msg: PeerResultMsg): void {
  peerWaiters.get(msg.requestId)?.(msg);
}

export function handleQuery(config: DaemonConfig, msg: QueryMsg, send: Send): void {
  const prior = threadQueues.get(msg.threadKey) ?? Promise.resolve();
  const next = prior.then(() => runOne(config, msg, send)).catch(() => {});
  threadQueues.set(msg.threadKey, next);
}

/**
 * Asks another host's agent via the broker and resolves with prose the model
 * can use either way: the answer, or why there isn't one. Ends early if the
 * session that asked is cancelled.
 */
function askPeer(send: Send, queryId: string, signal: AbortSignal, host: string, question: string): Promise<string> {
  return new Promise((resolve) => {
    const requestId = randomUUID();
    const finish = (text: string): void => {
      clearTimeout(timer);
      peerWaiters.delete(requestId);
      signal.removeEventListener("abort", onAbort);
      resolve(text);
    };
    const onAbort = (): void => finish("This question was cancelled before the other agent answered.");
    const timer = setTimeout(() => finish(`${host}'s agent did not answer in time.`), PEER_WAIT_MS);
    timer.unref();
    peerWaiters.set(requestId, (res) =>
      finish(
        res.ok
          ? res.text?.trim() || `${host}'s agent returned an empty answer.`
          : `${host}'s agent could not answer: ${res.error ?? "unknown error"}`,
      ),
    );
    signal.addEventListener("abort", onAbort, { once: true });
    // Redacted here too: the question leaves this machine for another one.
    send({ type: "ask_peer", queryId, requestId, hostName: host, question: redactSecrets(question).text });
  });
}

function toolText(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

async function runOne(config: DaemonConfig, msg: QueryMsg, send: Send): Promise<void> {
  const abort = new AbortController();
  inflight.set(msg.queryId, abort);
  const timeout = setTimeout(() => abort.abort(), QUERY_TIMEOUT_MS);
  const startedAt = Date.now();
  const emit = (state: QueryEvent["state"], costUsd?: number): void => {
    const event: QueryEvent = {
      state,
      queryId: msg.queryId,
      askerName: msg.askerName,
      question: msg.question,
      at: Date.now(),
    };
    if (msg.viaHost) event.viaHost = msg.viaHost;
    if (costUsd !== undefined) event.costUsd = costUsd;
    daemonEvents.emit("query", event);
  };

  notifyOwner(
    "Workspace Agent",
    msg.viaHost
      ? `${msg.viaHost}'s agent is asking your agent a question for ${msg.askerName}`
      : `${msg.askerName} is asking your agent a question`,
  );
  logLocal({
    event: "query_start",
    queryId: msg.queryId,
    asker: msg.askerName,
    viaHost: msg.viaHost ?? undefined,
    question: msg.question,
    model: config.model ?? "default",
  });
  emit("start");

  const denials: string[] = [];
  const roots = config.roots;
  const [primaryRoot, ...extraRoots] = roots;
  if (!primaryRoot) {
    send({ type: "result", queryId: msg.queryId, ok: false, error: "This host has no exposed directories." });
    clearTimeout(timeout);
    inflight.delete(msg.queryId);
    return;
  }

  // The consultation tool exists only for questions a person asked directly,
  // and only when there is someone to consult. The broker enforces the same.
  const canAsk = msg.depth === 0 && msg.peerAskLimit > 0 && msg.peers.length > 0;
  let consultations = 0;
  const peerServer = canAsk
    ? createSdkMcpServer({
        name: PEER_SERVER,
        version: "1.0.0",
        tools: [
          tool(
            ASK_TOOL,
            "Ask another coworker's read-only code agent a question about the code on their machine. Use it when the answer lives in their folders rather than here. They cannot see this conversation, so make the question self-contained.",
            {
              host: z.string().describe("The agent's name, exactly as listed in your instructions."),
              question: z
                .string()
                .describe("A specific, self-contained question, with the context they need to answer it."),
            },
            async ({ host, question }) => {
              const peer = msg.peers.find((p) => p.name.toLowerCase() === host.trim().toLowerCase());
              if (!peer) {
                return toolText(`No agent named "${host}". You can ask: ${msg.peers.map((p) => p.name).join(", ")}.`);
              }
              if (!peer.consultable) {
                return toolText(
                  `${peer.name}'s agent doesn't take questions from other agents. Suggest ${msg.askerName} ask it directly with "/ask ${peer.name} …".`,
                );
              }
              if (consultations >= msg.peerAskLimit) {
                return toolText(`You've used all ${msg.peerAskLimit} consultation(s) allowed for this question.`);
              }
              consultations++;
              logLocal({ event: "peer_ask", queryId: msg.queryId, host: peer.name, question });
              const answer = await askPeer(send, msg.queryId, abort.signal, peer.name, question);
              logLocal({ event: "peer_answer", queryId: msg.queryId, host: peer.name, chars: answer.length });
              const trimmed =
                answer.length > MAX_PEER_ANSWER_CHARS
                  ? answer.slice(0, MAX_PEER_ANSWER_CHARS) + "\n\n[answer truncated]"
                  : answer;
              return toolText(`${peer.name}'s agent answered:\n\n${trimmed}`);
            },
            // One tool, always in the prompt: no ToolSearch turn to discover it.
            { alwaysLoad: true },
          ),
        ],
      })
    : null;
  /**
   * Everything the session may call, and nothing is pre-approved: each call
   * has to pass canUseTool below, which is the root-containment and deny-list
   * gate. Putting names in `allowedTools` would auto-approve them before
   * that gate ran (the SDK warns about exactly this), so `tools` limits what
   * exists and the callback decides what runs.
   */
  const permitted = canAsk ? [...READ_ONLY_TOOLS, ASK_TOOL_FULL] : READ_ONLY_TOOLS;

  // Compared after following symlinks, so a link inside a root can't lead out.
  const realRoots = roots.map((root) => {
    try {
      return fs.realpathSync(root);
    } catch {
      return root;
    }
  });

  /**
   * The gate every tool call passes: tool allowlist, root containment, and
   * the secret deny-list. Returns the reason to refuse, or null to allow.
   */
  const vet = (toolName: string, input: Record<string, unknown>): string | null => {
    if (!permitted.includes(toolName)) {
      denials.push(`${toolName} (not read-only)`);
      return `${toolName} is not available in read-only guest sessions.`;
    }
    for (const raw of extractToolPaths(toolName, input)) {
      let candidate = path.resolve(primaryRoot, expandHome(raw));
      try {
        candidate = fs.realpathSync(candidate);
      } catch {
        // Nothing there (yet); judge the name as given.
      }
      const verdict = checkPath(candidate, realRoots, primaryRoot);
      if (!verdict.allowed) {
        denials.push(`${toolName} ${raw}`);
        logLocal({ event: "path_denied", queryId: msg.queryId, tool: toolName, path: raw, reason: verdict.reason });
        return `Blocked: ${verdict.reason}`;
      }
    }
    return null;
  };

  /** Whether a line of search output comes from a file the gate would refuse. */
  const fromProtectedFile = (line: string): boolean => {
    // Grep prints "path:line:text" (or "path-line-text" for context lines);
    // Glob and files-only modes print bare paths.
    const candidates = [line.split(":")[0] ?? "", line.match(/^(.+?)-\d+-/)?.[1] ?? ""];
    for (const raw of candidates) {
      if (!raw.trim()) continue;
      const abs = path.resolve(primaryRoot, expandHome(raw.trim()));
      let real = abs;
      try {
        real = fs.realpathSync(abs);
      } catch {
        continue; // not a path
      }
      if (!checkPath(real, realRoots, primaryRoot).allowed) return true;
    }
    return false;
  };

  /**
   * Search tools scan whole directories, so their results can quote files the
   * deny-list protects even though every path they were asked for passed.
   * Drops such lines wherever they appear in the tool's output.
   */
  const scrub = (value: unknown, counter: { dropped: number }): unknown => {
    if (typeof value === "string") {
      return value
        .split("\n")
        .filter((line) => {
          if (!fromProtectedFile(line)) return true;
          counter.dropped++;
          return false;
        })
        .join("\n");
    }
    if (Array.isArray(value)) return value.map((v) => scrub(v, counter));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v, counter)]));
    }
    return value;
  };

  const collected: string[] = [];
  let sessionId: string | undefined;

  try {
    const stream = query({
      prompt: msg.question,
      options: {
        cwd: primaryRoot,
        additionalDirectories: extraRoots,
        // Undefined leaves the choice to Claude Code, as the owner asked for.
        model: config.model,
        systemPrompt: buildSystemPrompt(msg, canAsk),
        tools: READ_ONLY_TOOLS,
        disallowedTools: ["Bash", "Write", "Edit", "NotebookEdit", "WebFetch", "WebSearch", "Task", "TodoWrite"],
        permissionMode: "default",
        maxTurns: MAX_TURNS,
        resume: msg.resumeSessionId ?? undefined,
        abortController: abort,
        // Never load the owner's CLAUDE.md / settings into a guest session.
        settingSources: [],
        // Only our consultation server; never MCP servers from the owner's own setup.
        mcpServers: peerServer ? { [PEER_SERVER]: peerServer } : {},
        strictMcpConfig: true,
        // Claude Code approves reads inside its working directory on its own,
        // without ever asking canUseTool; a PreToolUse hook runs on every call
        // no matter what, so the gate lives there. canUseTool applies the
        // same verdict to whatever does reach the permission prompt.
        hooks: {
          PreToolUse: [
            {
              hooks: [
                async (input) => {
                  if (input.hook_event_name !== "PreToolUse") return {};
                  const reason = vet(input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>);
                  if (!reason) return {};
                  return {
                    hookSpecificOutput: {
                      hookEventName: "PreToolUse",
                      permissionDecision: "deny",
                      permissionDecisionReason: reason,
                    },
                  };
                },
              ],
            },
          ],
          PostToolUse: [
            {
              hooks: [
                async (input) => {
                  if (input.hook_event_name !== "PostToolUse") return {};
                  if (input.tool_name !== "Grep" && input.tool_name !== "Glob") return {};
                  const counter = { dropped: 0 };
                  const output = scrub(input.tool_response, counter);
                  if (counter.dropped === 0) return {};
                  logLocal({ event: "results_scrubbed", queryId: msg.queryId, tool: input.tool_name, lines: counter.dropped });
                  return {
                    hookSpecificOutput: {
                      hookEventName: "PostToolUse",
                      updatedToolOutput: output,
                      additionalContext: `${counter.dropped} result line(s) came from protected files and were removed.`,
                    },
                  };
                },
              ],
            },
          ],
        },
        canUseTool: async (toolName, input) => {
          const reason = vet(toolName, input);
          return reason ? { behavior: "deny", message: reason } : { behavior: "allow", updatedInput: input };
        },
      },
    });

    for await (const message of stream) {
      if (message.type === "system" && message.subtype === "init") {
        sessionId = message.session_id;
      } else if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "text" && block.text.trim()) {
            collected.push(block.text);
            send({
              type: "partial",
              queryId: msg.queryId,
              text: redactSecrets(collected.join("\n\n")).text,
            });
          } else if (block.type === "tool_use") {
            const input = block.input as Record<string, unknown>;
            let note: string;
            if (block.name === ASK_TOOL_FULL) {
              note = `asking ${String(input.host ?? "another")}'s agent`;
            } else {
              const target = extractToolPaths(block.name, input)[0];
              note = target ? `${block.name.toLowerCase()}ing ${target}` : `running ${block.name}`;
            }
            send({ type: "status", queryId: msg.queryId, note });
          }
        }
      } else if (message.type === "result") {
        const finalText =
          message.subtype === "success" && message.result?.trim()
            ? message.result
            : collected.join("\n\n") || null;
        if (message.subtype === "success" && finalText) {
          send({
            type: "result",
            queryId: msg.queryId,
            ok: true,
            text: redactSecrets(finalText).text,
            sessionId,
            turns: message.num_turns,
            costUsd: message.total_cost_usd,
          });
          logLocal({
            event: "query_done",
            queryId: msg.queryId,
            ms: Date.now() - startedAt,
            turns: message.num_turns,
            costUsd: message.total_cost_usd,
            consultations,
            denials,
          });
          emit("done", message.total_cost_usd);
        } else {
          send({
            type: "result",
            queryId: msg.queryId,
            ok: false,
            error: `The agent stopped without an answer (${message.subtype}).`,
          });
          logLocal({ event: "query_failed", queryId: msg.queryId, subtype: message.subtype, denials });
          emit("error");
        }
      }
    }
  } catch (err) {
    const aborted = abort.signal.aborted;
    send({
      type: "result",
      queryId: msg.queryId,
      ok: false,
      error: aborted ? "The query was cancelled or timed out." : `Agent error: ${(err as Error).message}`,
    });
    logLocal({ event: "query_error", queryId: msg.queryId, error: String(err), aborted });
    emit("error");
  } finally {
    clearTimeout(timeout);
    inflight.delete(msg.queryId);
  }
}
