# Deploying the broker

The broker runs on one small Linux box that daemons and the dashboard can reach
over HTTPS/WSS. Today that is the office DGX Spark, published through a
Cloudflare tunnel as `https://broker.tl-admin.com`; the same recipe works on any
host. The box runs a **git checkout** of this repository, so an update is a pull
and a restart.

## One-time setup

```sh
git clone https://github.com/austinulfers/workspace-agent.git ~/understudy
cd ~/understudy
pnpm install --frozen-lockfile
cp .env.example .env      # Slack tokens, ADMIN_TOKEN, ADMIN_SLACK_IDS
mkdir -p data             # the SQLite database lives here; git ignores it
```

Install the unit as `/etc/systemd/system/understudy-broker.service`,
adjusting the user and home directory:

```ini
[Unit]
Description=Understudy broker (Slack Socket Mode + daemon WS hub)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=trainloop
Group=trainloop
WorkingDirectory=/home/trainloop/understudy/packages/broker
EnvironmentFile=/home/trainloop/understudy/.env
Environment=NODE_ENV=production
Environment=DB_PATH=/home/trainloop/understudy/data/understudy.db
ExecStart=/home/trainloop/understudy/packages/broker/node_modules/.bin/tsx src/index.ts
Restart=always
RestartSec=5
SyslogIdentifier=understudy-broker
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl enable --now understudy-broker
journalctl -u understudy-broker -f
```

Drop the current app DMG from [Releases](https://github.com/austinulfers/workspace-agent/releases)
into `packages/broker/downloads/` (git ignores it) so every enrollment token page
links to the installer.

## Updating

```sh
cd ~/understudy
git pull --ff-only
pnpm install --frozen-lockfile        # only when pnpm-lock.yaml changed
sudo systemctl restart understudy-broker
journalctl -u understudy-broker -n 20 --no-pager
```

Schema migrations run at startup. A restart drops every daemon for a few seconds
and loses in-flight answers; daemons reconnect on their own.

If the box is reached through a Cloudflare tunnel, never restart `cloudflared`
from an SSH session that rides the same tunnel: the session dies with it, and the
box may need physical access to recover.

## A box set up before the rename

Boxes deployed while this project was called Workspace Agent run
`workspace-agent-broker` from `~/workspace-agent`, with the database at
`data/workspace-agent.db`. Nothing in the broker depends on those names, so such
a box keeps working after a pull; the restart above is all the rename needs. To
make the box match this document anyway:

```sh
sudo systemctl disable --now workspace-agent-broker
mv ~/workspace-agent ~/understudy
mv ~/understudy/data/workspace-agent.db ~/understudy/data/understudy.db
sudo mv /etc/systemd/system/workspace-agent-broker.service /etc/systemd/system/understudy-broker.service
sudo sed -i 's#/workspace-agent#/understudy#g; s#=workspace-agent-broker#=understudy-broker#; s#^Description=.*#Description=Understudy broker (Slack Socket Mode + daemon WS hub)#' /etc/systemd/system/understudy-broker.service
sudo systemctl daemon-reload
sudo systemctl enable --now understudy-broker
journalctl -u understudy-broker -n 20 --no-pager
```

Stop the service before moving the database: SQLite then closes cleanly and
folds its `-wal` and `-shm` files back in, leaving one file to rename. Daemons
reconnect on their own once the broker is back, and nobody re-enrolls. Replace
the old `Workspace-Agent-*.dmg` in `packages/broker/downloads/` with the current
`Understudy-*.dmg` too; the token page lists whatever is in that directory.
