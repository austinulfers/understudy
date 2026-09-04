import * as fs from "node:fs";
import {
  CONFIG_DIR,
  DEFAULT_PROMPT,
  deleteConfig,
  loadConfig,
  MODEL_CHOICES,
  modelLabel,
  normalizePrompt,
  normalizeRoot,
  saveConfig,
} from "./config";
import { runDaemon } from "./connection";
import { daemonEvents, type QueryEvent } from "./events";
import { notifyOwner, queryNotice } from "./notify";

const USAGE = `understudy — read-only Claude agent for your machine, reachable from Slack

Usage:
  enroll --broker <url> --token <token> --root <dir> [--root <dir> ...]
  start                 run the daemon (foreground)
  pause | resume        toggle whether queries are answered
  roots list|add <dir>|remove <dir>
  model list|set <model>|default
  prompt show|set <file>|default
                        the agent's instructions; \`set -\` reads them from stdin
  status                show enrollment and exposed directories
  unenroll              revoke this machine's access and delete local creds
`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function flagAll(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === `--${name}`) out.push(args[i + 1]!);
  }
  return out;
}

/** Instructions from a file, or stdin for `-`, ready to store; exits on a bad one. */
function readPromptFile(file: string): string | undefined {
  try {
    return normalizePrompt(fs.readFileSync(file === "-" ? 0 : file, "utf8"));
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}

function requireConfig() {
  const config = loadConfig();
  if (!config) {
    console.error("Not enrolled. Run `enroll` first.");
    process.exit(1);
  }
  return config;
}

async function enroll(args: string[]): Promise<void> {
  const broker = flag(args, "broker");
  const token = flag(args, "token");
  const roots = flagAll(args, "root").map(normalizeRoot);
  if (!broker || !token || roots.length === 0) {
    console.error("enroll needs --broker <url>, --token <token>, and at least one --root <dir>");
    process.exit(1);
  }
  if (loadConfig()) {
    console.error(`Already enrolled (config in ${CONFIG_DIR}). Run \`unenroll\` first.`);
    process.exit(1);
  }
  const res = await fetch(`${broker.replace(/\/$/, "")}/api/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  }).catch((err: Error) => {
    console.error(`Could not reach the broker at ${broker}: ${err.cause ?? err.message}`);
    console.error("Check the --broker URL, and that the broker is running.");
    process.exit(1);
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    console.error(`Enrollment failed: ${body.error ?? res.statusText}`);
    process.exit(1);
  }
  const creds = (await res.json()) as { deviceId: string; deviceSecret: string; hostName: string };
  saveConfig({
    brokerUrl: broker.replace(/\/$/, ""),
    deviceId: creds.deviceId,
    deviceSecret: creds.deviceSecret,
    hostName: creds.hostName,
    roots,
    paused: false,
  });
  console.log(`Enrolled as "${creds.hostName}". Exposed directories:`);
  for (const r of roots) console.log(`  ${r}`);
  console.log(`\nCoworkers can now ask your agent via Slack. Start it with:\n  pnpm daemon start`);
  console.log(`Pause any time with \`pnpm daemon pause\`; leave for good with \`pnpm daemon unenroll\`.`);
}

async function unenroll(): Promise<void> {
  const config = requireConfig();
  const res = await fetch(`${config.brokerUrl}/api/unenroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId: config.deviceId, deviceSecret: config.deviceSecret }),
  }).catch(() => null);
  if (!res?.ok) {
    console.warn("Could not reach the broker to revoke; deleting local credentials anyway.");
  }
  deleteConfig();
  console.log("Unenrolled. Local credentials deleted; the broker no longer accepts this device.");
}

const [cmd, ...rest] = process.argv.slice(2);

switch (cmd) {
  case "enroll":
    await enroll(rest);
    break;
  case "start": {
    const config = requireConfig();
    console.log(`[daemon] host "${config.hostName}", exposing:\n${config.roots.map((r) => `  ${r}`).join("\n")}`);
    // No app bundle to file notifications under, so osascript has to do.
    daemonEvents.on("query", (event: QueryEvent) => {
      if (event.state === "start") notifyOwner("Understudy", queryNotice(event));
    });
    runDaemon(config);
    break;
  }
  case "pause":
  case "resume": {
    const config = requireConfig();
    config.paused = cmd === "pause";
    saveConfig(config);
    console.log(cmd === "pause" ? "Paused. Queries will be refused until `resume`." : "Resumed.");
    break;
  }
  case "roots": {
    const config = requireConfig();
    const [sub, dir] = rest;
    if (sub === "add" && dir) {
      const normalized = normalizeRoot(dir);
      if (!config.roots.includes(normalized)) config.roots.push(normalized);
      saveConfig(config);
    } else if (sub === "remove" && dir) {
      const normalized = normalizeRoot(dir);
      config.roots = config.roots.filter((r) => r !== normalized);
      saveConfig(config);
    } else if (sub !== "list") {
      console.error("Usage: roots list | roots add <dir> | roots remove <dir>");
      process.exit(1);
    }
    for (const r of config.roots) console.log(r);
    break;
  }
  case "model": {
    const config = requireConfig();
    const [sub, id] = rest;
    if (sub === "set" && id) {
      config.model = id;
      saveConfig(config);
      console.log(`Answering with ${modelLabel(id)}. Takes effect on the next question.`);
    } else if (sub === "default") {
      delete config.model;
      saveConfig(config);
      console.log("Back to Claude Code's default model.");
    } else if (sub === "list") {
      for (const choice of MODEL_CHOICES) {
        const current = (choice.id ?? undefined) === config.model ? "*" : " ";
        console.log(`${current} ${(choice.id ?? "default").padEnd(20)} ${choice.label} — ${choice.hint}`);
      }
      console.log("\n`model set <id>` also takes any other model id Claude Code accepts.");
    } else {
      console.error("Usage: model list | model set <model> | model default");
      process.exit(1);
    }
    break;
  }
  case "prompt": {
    const config = requireConfig();
    const [sub, file] = rest;
    if (sub === "set" && file) {
      const prompt = readPromptFile(file);
      if (prompt) config.prompt = prompt;
      else delete config.prompt;
      saveConfig(config);
      console.log(
        prompt ? "Instructions saved. They apply from the next question." : "That is the default text; using the default instructions.",
      );
    } else if (sub === "default") {
      delete config.prompt;
      saveConfig(config);
      console.log("Back to the default instructions.");
    } else if (sub === "show") {
      // The note goes to stderr, so `prompt show > file` captures only the instructions.
      console.log(config.prompt ?? DEFAULT_PROMPT);
      console.error(
        config.prompt ? "\n(your instructions; `prompt default` restores the default)" : "\n(the default; `prompt set <file>` replaces it)",
      );
    } else {
      console.error("Usage: prompt show | prompt set <file> | prompt default   (`set -` reads stdin)");
      process.exit(1);
    }
    break;
  }
  case "status": {
    const config = requireConfig();
    console.log(`host:    ${config.hostName}`);
    console.log(`broker:  ${config.brokerUrl}`);
    console.log(`paused:  ${config.paused}`);
    console.log(`model:   ${modelLabel(config.model)}`);
    console.log(`prompt:  ${config.prompt ? "custom" : "default"}`);
    console.log(`roots:   ${config.roots.join(", ")}`);
    break;
  }
  case "unenroll":
    await unenroll();
    break;
  default:
    console.log(USAGE);
    process.exit(cmd ? 1 : 0);
}
