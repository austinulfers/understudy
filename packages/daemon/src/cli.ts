import {
  CONFIG_DIR,
  deleteConfig,
  loadConfig,
  MODEL_CHOICES,
  modelLabel,
  normalizeRoot,
  saveConfig,
} from "./config";
import { runDaemon } from "./connection";

const USAGE = `workspace-agent — read-only Claude agent for your machine, reachable from Slack

Usage:
  enroll --broker <url> --token <token> --root <dir> [--root <dir> ...]
  start                 run the daemon (foreground)
  pause | resume        toggle whether queries are answered
  roots list|add <dir>|remove <dir>
  model list|set <model>|default
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
  case "status": {
    const config = requireConfig();
    console.log(`host:    ${config.hostName}`);
    console.log(`broker:  ${config.brokerUrl}`);
    console.log(`paused:  ${config.paused}`);
    console.log(`model:   ${modelLabel(config.model)}`);
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
