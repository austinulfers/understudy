import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expandHome } from "@understudy/shared";

export interface DaemonConfig {
  brokerUrl: string;
  deviceId: string;
  deviceSecret: string;
  hostName: string;
  /** Absolute directories the read-only agent may see. */
  roots: string[];
  paused: boolean;
  /** Model the guest agent answers with; unset means Claude Code's default. */
  model?: string;
  /**
   * The owner's own instructions for the guest agent, in place of
   * DEFAULT_PROMPT; unset means the default. Read-only tools, root
   * containment, and secret redaction are enforced in code, never here.
   */
  prompt?: string;
}

export interface ModelChoice {
  /** Model id for the Agent SDK; null means "leave it to Claude Code". */
  id: string | null;
  label: string;
  hint: string;
}

/** What the tray menu and `daemon model list` offer. Any other id still works. */
export const MODEL_CHOICES: ModelChoice[] = [
  { id: null, label: "Default", hint: "whatever Claude Code picks" },
  { id: "claude-opus-5", label: "Opus 5", hint: "most capable, priciest" },
  { id: "claude-sonnet-5", label: "Sonnet 5", hint: "balanced" },
  { id: "claude-haiku-4-5", label: "Haiku 4.5", hint: "fastest and cheapest" },
];

/** Menu-friendly name for a configured model, falling back to the raw id. */
export function modelLabel(model: string | undefined): string {
  const choice = MODEL_CHOICES.find((c) => c.id === (model ?? null));
  return choice ? choice.label : model!;
}

/**
 * How the guest agent is told to behave, unless the owner wrote their own
 * (`config.prompt`). Either way, sessions append what to know about other
 * coworkers' agents after it, so this is the first part of the system prompt.
 */
export const DEFAULT_PROMPT = `You are a read-only assistant answering a coworker's question about the code on this machine, on behalf of its owner. You can read, search, and list files, nothing else.

Guidelines:
- Answer the question directly and concisely; this is going into a Slack message.
- Cite file paths (with line numbers where useful) so the asker can look for themselves.
- If the answer isn't in the exposed code, say so plainly rather than guessing.
- Never quote the contents of anything that looks like a credential or secret.`;

/** A page or two is plenty; anything longer crowds the code out of context. */
export const MAX_PROMPT_CHARS = 8000;

/**
 * What to store for instructions the owner typed: undefined for blank or the
 * default text (so the default keeps applying, and keeps improving with
 * updates), the trimmed text otherwise. Throws when it is too long to store.
 */
export function normalizePrompt(text: string): string | undefined {
  const trimmed = text.replace(/\r\n/g, "\n").trim();
  if (!trimmed || trimmed === DEFAULT_PROMPT) return undefined;
  if (trimmed.length > MAX_PROMPT_CHARS) {
    throw new Error(
      `Instructions can be at most ${MAX_PROMPT_CHARS.toLocaleString()} characters; these are ${trimmed.length.toLocaleString()}.`,
    );
  }
  return trimmed;
}

export const CONFIG_DIR = path.join(os.homedir(), ".understudy");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
export const LOG_DIR = path.join(CONFIG_DIR, "logs");

/** Where every install kept its credentials, roots, and logs before the app was renamed Understudy. */
const LEGACY_CONFIG_DIR = path.join(os.homedir(), ".workspace-agent");

/**
 * Carry a pre-rename install over so nobody has to enroll again. Runs when this
 * module loads, ahead of anything that reads or writes the directory, and only
 * ever once: after the move there is nothing left at the old path.
 */
function adoptLegacyConfigDir(): void {
  if (fs.existsSync(CONFIG_DIR) || !fs.existsSync(LEGACY_CONFIG_DIR)) return;
  try {
    fs.renameSync(LEGACY_CONFIG_DIR, CONFIG_DIR);
  } catch (err) {
    console.error(`[config] could not move ${LEGACY_CONFIG_DIR} to ${CONFIG_DIR}:`, err);
  }
}
adoptLegacyConfigDir();

export function loadConfig(): DaemonConfig | null {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as DaemonConfig;
  } catch {
    return null;
  }
}

export function saveConfig(config: DaemonConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}

export function deleteConfig(): void {
  fs.rmSync(CONFIG_PATH, { force: true });
}

export function normalizeRoot(root: string): string {
  const resolved = path.resolve(expandHome(root));
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`Not a directory: ${resolved}`);
  }
  return resolved;
}
