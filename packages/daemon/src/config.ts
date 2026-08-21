import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expandHome } from "@workspace-agent/shared";

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

export const CONFIG_DIR = path.join(os.homedir(), ".workspace-agent");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
export const LOG_DIR = path.join(CONFIG_DIR, "logs");

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
