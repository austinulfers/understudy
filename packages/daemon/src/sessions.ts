import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  checkPath,
  extractToolPaths,
  redactSecrets,
  type BrokerToDaemon,
  type DaemonToBroker,
} from "@workspace-agent/shared";
import type { DaemonConfig } from "./config";
import { daemonEvents } from "./events";
import { logLocal } from "./log";
import { notifyOwner } from "./notify";

const READ_ONLY_TOOLS = ["Read", "Grep", "Glob"];
const QUERY_TIMEOUT_MS = Number(process.env.WA_QUERY_TIMEOUT_MS ?? 5 * 60 * 1000);
const MAX_TURNS = 40;

type QueryMsg = Extract<BrokerToDaemon, { type: "query" }>;
type Send = (msg: DaemonToBroker) => void;

const SYSTEM_PROMPT = `You are a read-only assistant answering a coworker's question about the code on this machine, on behalf of its owner. You can read, search, and list files, nothing else.

Guidelines:
- Answer the question directly and concisely; this is going into a Slack message.
- Cite file paths (with line numbers where useful) so the asker can look for themselves.
- If the answer isn't in the exposed code, say so plainly rather than guessing.
- Never quote the contents of anything that looks like a credential or secret.`;

/** Live queries by id, so a broker cancel frame can abort mid-flight. */
const inflight = new Map<string, AbortController>();

/**
 * One promise chain per conversation: follow-ups resume the same SDK
 * session, and resuming a session concurrently with itself corrupts it.
 */
const threadQueues = new Map<string, Promise<void>>();

export function cancelQuery(queryId: string): void {
  inflight.get(queryId)?.abort();
}

export function handleQuery(config: DaemonConfig, msg: QueryMsg, send: Send): void {
  const prior = threadQueues.get(msg.threadKey) ?? Promise.resolve();
  const next = prior.then(() => runOne(config, msg, send)).catch(() => {});
  threadQueues.set(msg.threadKey, next);
}

async function runOne(config: DaemonConfig, msg: QueryMsg, send: Send): Promise<void> {
  const abort = new AbortController();
  inflight.set(msg.queryId, abort);
  const timeout = setTimeout(() => abort.abort(), QUERY_TIMEOUT_MS);
  const startedAt = Date.now();

  notifyOwner("Workspace Agent", `${msg.askerName} is asking your agent a question`);
  logLocal({ event: "query_start", queryId: msg.queryId, asker: msg.askerName, question: msg.question, model: config.model ?? "default" });
  daemonEvents.emit("query", {
    state: "start",
    queryId: msg.queryId,
    askerName: msg.askerName,
    question: msg.question,
    at: startedAt,
  });

  const denials: string[] = [];
  const roots = config.roots;
  const [primaryRoot, ...extraRoots] = roots;
  if (!primaryRoot) {
    send({ type: "result", queryId: msg.queryId, ok: false, error: "This host has no exposed directories." });
    clearTimeout(timeout);
    inflight.delete(msg.queryId);
    return;
  }

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
        systemPrompt: SYSTEM_PROMPT,
        allowedTools: READ_ONLY_TOOLS,
        disallowedTools: ["Bash", "Write", "Edit", "NotebookEdit", "WebFetch", "WebSearch", "Task", "TodoWrite"],
        permissionMode: "default",
        maxTurns: MAX_TURNS,
        resume: msg.resumeSessionId ?? undefined,
        abortController: abort,
        // Never load the owner's CLAUDE.md / settings into a guest session.
        settingSources: [],
        canUseTool: async (toolName, input) => {
          if (!READ_ONLY_TOOLS.includes(toolName)) {
            denials.push(`${toolName} (not read-only)`);
            return { behavior: "deny", message: `${toolName} is not available in read-only guest sessions.` };
          }
          for (const p of extractToolPaths(toolName, input)) {
            const verdict = checkPath(p, roots);
            if (!verdict.allowed) {
              denials.push(`${toolName} ${p}`);
              logLocal({ event: "path_denied", queryId: msg.queryId, tool: toolName, path: p, reason: verdict.reason });
              return { behavior: "deny", message: `Blocked: ${verdict.reason}` };
            }
          }
          return { behavior: "allow", updatedInput: input };
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
            const target = extractToolPaths(block.name, block.input as Record<string, unknown>)[0];
            send({
              type: "status",
              queryId: msg.queryId,
              note: target ? `${block.name.toLowerCase()}ing ${target}` : `running ${block.name}`,
            });
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
            denials,
          });
          daemonEvents.emit("query", {
            state: "done",
            queryId: msg.queryId,
            askerName: msg.askerName,
            question: msg.question,
            at: Date.now(),
            costUsd: message.total_cost_usd,
          });
        } else {
          send({
            type: "result",
            queryId: msg.queryId,
            ok: false,
            error: `The agent stopped without an answer (${message.subtype}).`,
          });
          logLocal({ event: "query_failed", queryId: msg.queryId, subtype: message.subtype, denials });
          daemonEvents.emit("query", {
            state: "error",
            queryId: msg.queryId,
            askerName: msg.askerName,
            question: msg.question,
            at: Date.now(),
          });
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
    daemonEvents.emit("query", {
      state: "error",
      queryId: msg.queryId,
      askerName: msg.askerName,
      question: msg.question,
      at: Date.now(),
    });
  } finally {
    clearTimeout(timeout);
    inflight.delete(msg.queryId);
  }
}
