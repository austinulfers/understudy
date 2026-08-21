# Workspace Agent

Ask a coworker's Claude a question from Slack. Each participating coworker runs a small
daemon on their dev machine; questions from Slack spin up a **read-only Claude Code
session** (Claude Agent SDK) scoped to directories they chose to expose, and the answer
streams back into the Slack thread. Access is invitation-only, revocable in one click,
and every conversation is audited.

```
Slack ──Socket Mode──► Broker ◄──WSS (daemon dials out)── Daemon ──spawns──► read-only Claude Code
                        │ ACLs · audit log · dashboard          │ path allowlist · secret deny-list
```

Everything connects **outbound**: nobody opens a port on their laptop.

## Components

| Package | Runs on | What it does |
|---|---|---|
| `packages/broker` | a small server (Fly.io, VPS, or your machine to start) | Slack app (Socket Mode), WebSocket hub for daemons, enrollment + revocation, ACLs, rate limits/budgets, audit log, admin dashboard at `/admin` |
| `packages/app` | each coworker's Mac (recommended) | Menu-bar app wrapping the daemon: one-click `workspace-agent://` enrollment links, native folder picker, pause/resume, model picker, recent questions, start-at-login, unenroll — no terminal needed. Ships the Claude Code runtime; the owner just needs to be signed in. |
| `packages/daemon` | each coworker's machine (CLI alternative) | Outbound WSS connection, spawns read-only Agent SDK sessions, path containment, secret redaction, local audit log, desktop notifications, pause/unenroll kill switch |
| `packages/shared` | both | Wire protocol (zod), path containment rules, secret redaction |

## Setup

### 1. Create the Slack app

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → *From an app manifest* → paste `slack-app-manifest.yaml`.
2. **Basic Information → App-Level Tokens**: create a token with scope `connections:write` → this is `SLACK_APP_TOKEN` (xapp-…).
3. **Install App** to your workspace → **Bot User OAuth Token** is `SLACK_BOT_TOKEN` (xoxb-…).

### 2. Run the broker

```sh
pnpm install
cp .env.example .env        # fill in tokens, ADMIN_TOKEN, your Slack user ID
set -a; source .env; set +a
pnpm broker
```

The dashboard is at `http://localhost:8787/admin` (user `admin`, password = `ADMIN_TOKEN`).
For real use, put the broker somewhere daemons can reach over HTTPS/WSS (Fly.io,
Railway, a VPS behind Caddy). Only the daemons and the dashboard need to reach it —
Slack does not (Socket Mode dials out).

### 3. Build the Mac app (once)

```sh
pnpm app dist                                      # → packages/app/release/Workspace Agent-<v>-arm64.dmg
cp "packages/app/release/Workspace Agent"*.dmg packages/broker/downloads/
```

The broker now serves the installer at `/downloads/…` and links it from every token page.
The build is unsigned by default (`identity: null`) — first launch is right-click → Open.
With an Apple Developer ID, set `identity` in `packages/app/package.json` to sign + notarize.

### 4. Enroll a coworker (no terminal involved)

1. Dashboard → **Enroll a new coworker** → host name (`jane`) + their Slack user ID.
2. The token page gives you a download link and a one-click `workspace-agent://enroll?…`
   link — send both to them privately.
3. They install the app, click the link, pick which folders to share in a native
   dialog, and hit **Enroll This Mac**. The app lives in the menu bar, starts at
   login, and answers begin flowing. Sessions run on **their** Claude sign-in
   (the app detects it and points them at claude.com/claude-code if missing).
4. Access is theirs to give: the new owner DMs the bot `allow @coworker` (or uses the
   app's **People** tab) to choose who may ask their agent. The owner is allowed
   automatically; IDs in `ADMIN_SLACK_IDS` bypass ACLs; your dashboard can still
   add/remove anyone as an override.

CLI alternative (any platform): `pnpm daemon enroll --broker <url> --token <T> --root ~/code/repo && pnpm daemon start`.

### 5. Ask things

- **Channel:** `/ask jane where does token refresh happen?` — the bot posts the question, answers in the thread, and thread replies continue the same session. (`/invite @Workspace Agent` to the channel first.)
- **Mention:** `@Workspace Agent jane: what runs on deploy?`
- **DM the bot:** `jane: where is the retry logic?` — after that, just keep typing; the DM stays pointed at jane until you name another host or say `reset`. `hosts` lists agents you can reach, `help` explains all of this.

If a host is offline, asleep, or paused, the bot says so immediately.

## Host-owner controls

Everything is in the menu-bar app. The tray menu has pause/resume, shared folders,
**Answer Model**, recent questions, start at login, and **Unenroll This Mac**.
**Open Workspace Agent…** opens the owner panel:

- **People** — who may ask your agent: search coworkers by name, add/remove.
  Same power from your DM with the bot: `allow @name`, `deny @name`, `team`.
  Grantees get a courtesy DM explaining how to ask (needs the `im:write` scope —
  re-install the Slack app after updating the manifest).
- **Conversations** — every conversation that ran on your machine, with full
  transcripts.
- **Budget** — questions run on *your* Claude account, so the daily cap is yours:
  team default or a custom number, plus today's usage.

**Answer Model** picks which Claude model answers coworkers' questions — Claude
Code's default, Opus 5, Sonnet 5, or Haiku 4.5. Since the questions bill to your
account, this is the cost/quality dial next to the daily cap: Haiku for a cheap
agent that mostly points people at files, Opus for one that reasons across a
codebase. It takes effect on the next question; in-flight answers finish on the
model they started with, and a follow-up in an existing Slack thread switches
that conversation over too.

The CLI offers the daemon basics too:

```sh
pnpm daemon pause      # refuse queries until resume (picked up within 5s while running)
pnpm daemon resume
pnpm daemon roots list|add <dir>|remove <dir>
pnpm daemon model list|set <model>|default   # `set` takes any id Claude Code accepts
pnpm daemon status
pnpm daemon unenroll   # revoke this machine and delete local credentials
```

Every query fires a macOS notification, and a local JSONL mirror of all activity is
kept in `~/.workspace-agent/logs/` — the owner never has to trust the broker's log alone.

## Security model

- **Read-only, twice over.** Sessions run with only `Read`/`Grep`/`Glob` allowed, and a
  `canUseTool` hook independently re-checks every call: paths must resolve inside an
  exposed root and must not match the secret deny-list (`.env*`, key files, `.ssh/`,
  `.aws/`, `.claude/`, …). No Bash, no writes, no web access, and guest sessions never
  load the owner's `CLAUDE.md`/settings.
- **Redaction on both ends.** Credential-shaped strings (PEM blocks, `sk-…`, `AKIA…`,
  `xoxb-…`, JWTs, `password=…`) are scrubbed on the daemon before the answer leaves the
  machine, and again on the broker before posting to Slack.
- **Default-deny access, owner-granted.** Nobody can query a host until its owner
  grants them access (`allow @name` in Slack or the app's People tab); admins bypass
  and can override from the dashboard, and every grant records who made it.
  Revoking a host severs its socket immediately and refuses reconnects.
- **Budgets.** Per-asker rate limit (6/min) and per-host daily query cap (50 by default) —
  queries run on the host's Claude plan.
- **Honest boundary:** read-only is not "safe" — anyone with query access can read any
  exposed source through the agent. Grant access like you'd grant repo access.

## Development

```sh
pnpm typecheck        # all packages
pnpm broker           # run broker (needs env)
pnpm daemon <cmd>     # daemon CLI
```
