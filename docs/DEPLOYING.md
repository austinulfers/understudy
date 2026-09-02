# Deploying the broker

The broker runs on one small Linux box that daemons and the dashboard can reach
over HTTPS/WSS. Today that is the office DGX Spark, published through a
Cloudflare tunnel as `https://broker.tl-admin.com`; the same recipe works on any
host. The box runs a **git checkout** of this repository, so an update is a pull
and a restart.

## One-time setup

```sh
git clone https://github.com/austinulfers/workspace-agent.git ~/workspace-agent
cd ~/workspace-agent
pnpm install --frozen-lockfile
cp .env.example .env      # Slack tokens, ADMIN_TOKEN, ADMIN_SLACK_IDS
mkdir -p data             # the SQLite database lives here; git ignores it
```

Install the unit as `/etc/systemd/system/workspace-agent-broker.service`,
adjusting the user and home directory:

```ini
[Unit]
Description=workspace-agent broker (Slack Socket Mode + daemon WS hub)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=trainloop
Group=trainloop
WorkingDirectory=/home/trainloop/workspace-agent/packages/broker
EnvironmentFile=/home/trainloop/workspace-agent/.env
Environment=NODE_ENV=production
Environment=DB_PATH=/home/trainloop/workspace-agent/data/workspace-agent.db
ExecStart=/home/trainloop/workspace-agent/packages/broker/node_modules/.bin/tsx src/index.ts
Restart=always
RestartSec=5
SyslogIdentifier=workspace-agent-broker
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl enable --now workspace-agent-broker
journalctl -u workspace-agent-broker -f
```

Drop the current app DMG from [Releases](https://github.com/austinulfers/workspace-agent/releases)
into `packages/broker/downloads/` (git ignores it) so every enrollment token page
links to the installer.

## Updating

```sh
cd ~/workspace-agent
git pull --ff-only
pnpm install --frozen-lockfile        # only when pnpm-lock.yaml changed
sudo systemctl restart workspace-agent-broker
journalctl -u workspace-agent-broker -n 20 --no-pager
```

Schema migrations run at startup. A restart drops every daemon for a few seconds
and loses in-flight answers; daemons reconnect on their own.

If the box is reached through a Cloudflare tunnel, never restart `cloudflared`
from an SSH session that rides the same tunnel: the session dies with it, and the
box may need physical access to recover.
