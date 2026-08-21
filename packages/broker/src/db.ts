import Database from "better-sqlite3";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { config } from "./config";

export const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS hosts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE,
  owner_slack_id TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  daily_limit INTEGER,
  last_seen INTEGER,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS enroll_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  host_name TEXT NOT NULL,
  owner_slack_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE TABLE IF NOT EXISTS acls (
  host_id TEXT NOT NULL REFERENCES hosts(id),
  slack_user_id TEXT NOT NULL,
  PRIMARY KEY (host_id, slack_user_id)
);
CREATE TABLE IF NOT EXISTS threads (
  thread_key TEXT PRIMARY KEY,
  host_id TEXT NOT NULL REFERENCES hosts(id),
  sdk_session_id TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_active INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS dm_prefs (
  channel TEXT PRIMARY KEY,
  host_id TEXT NOT NULL REFERENCES hosts(id),
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS transcripts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_key TEXT NOT NULL,
  host_id TEXT NOT NULL,
  asker_slack_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_transcripts_thread ON transcripts(thread_key, id);
CREATE INDEX IF NOT EXISTS idx_transcripts_host ON transcripts(host_id, created_at);
CREATE TABLE IF NOT EXISTS usage (
  host_id TEXT NOT NULL,
  day TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (host_id, day)
);
`);

// Migration: early schemas had UNIQUE on hosts.name, which blocked
// re-enrolling a machine under its old name after unenroll/revoke.
// Uniqueness now applies to ACTIVE hosts only (partial index below).
{
  const hostsSql =
    (db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'hosts'`).get() as
      | { sql: string }
      | undefined)?.sql ?? "";
  if (/UNIQUE/i.test(hostsSql)) {
    db.pragma("foreign_keys = OFF");
    db.exec(`
      BEGIN;
      CREATE TABLE hosts_new (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL COLLATE NOCASE,
        owner_slack_id TEXT NOT NULL,
        secret_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        daily_limit INTEGER,
        last_seen INTEGER,
        created_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
      INSERT INTO hosts_new
        SELECT id, name, owner_slack_id, secret_hash, status, daily_limit, last_seen, created_at, revoked_at
        FROM hosts;
      DROP TABLE hosts;
      ALTER TABLE hosts_new RENAME TO hosts;
      COMMIT;
    `);
    db.pragma("foreign_keys = ON");
  }
}

db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_hosts_active_name ON hosts(name) WHERE status = 'active';`);

// Migration: acls gained provenance columns when self-service grants shipped.
{
  const aclCols = (db.pragma("table_info(acls)") as { name: string }[]).map((c) => c.name);
  if (!aclCols.includes("granted_by")) {
    db.exec(`ALTER TABLE acls ADD COLUMN granted_by TEXT; ALTER TABLE acls ADD COLUMN granted_at INTEGER;`);
  }
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export interface HostRow {
  id: string;
  name: string;
  owner_slack_id: string;
  secret_hash: string;
  status: "active" | "revoked";
  daily_limit: number | null;
  last_seen: number | null;
  created_at: number;
  revoked_at: number | null;
}

export interface ThreadRow {
  thread_key: string;
  host_id: string;
  sdk_session_id: string | null;
  created_by: string;
  created_at: number;
  last_active: number;
}

export interface TranscriptRow {
  id: number;
  thread_key: string;
  host_id: string;
  asker_slack_id: string;
  role: string;
  content: string;
  created_at: number;
}

// --- enrollment tokens ---

export function mintEnrollToken(hostName: string, ownerSlackId: string): string {
  const token = randomBytes(24).toString("base64url");
  db.prepare(
    `INSERT INTO enroll_tokens (id, token_hash, host_name, owner_slack_id, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(randomUUID(), sha256(token), hostName, ownerSlackId, Date.now(), Date.now() + 24 * 3600 * 1000);
  return token;
}

/** Redeem a one-time token: creates the host row and returns device creds. */
export function redeemEnrollToken(token: string): { deviceId: string; deviceSecret: string; hostName: string } | null {
  const row = db
    .prepare(`SELECT * FROM enroll_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`)
    .get(sha256(token), Date.now()) as { id: string; host_name: string; owner_slack_id: string } | undefined;
  if (!row) return null;

  const deviceId = randomUUID();
  const deviceSecret = randomBytes(48).toString("base64url");
  const insert = db.transaction(() => {
    db.prepare(`UPDATE enroll_tokens SET used_at = ? WHERE id = ?`).run(Date.now(), row.id);
    db.prepare(
      `INSERT INTO hosts (id, name, owner_slack_id, secret_hash, status, created_at)
       VALUES (?, ?, ?, ?, 'active', ?)`,
    ).run(deviceId, row.host_name, row.owner_slack_id, sha256(deviceSecret), Date.now());
    // The owner can always query their own agent.
    db.prepare(
      `INSERT OR IGNORE INTO acls (host_id, slack_user_id, granted_by, granted_at) VALUES (?, ?, 'system', ?)`,
    ).run(deviceId, row.owner_slack_id, Date.now());
  });
  try {
    insert();
  } catch {
    return null; // host name already taken by an active enrollment
  }
  return { deviceId, deviceSecret, hostName: row.host_name };
}

// --- hosts ---

export function getHostById(id: string): HostRow | undefined {
  return db.prepare(`SELECT * FROM hosts WHERE id = ?`).get(id) as HostRow | undefined;
}

export function getHostByName(name: string): HostRow | undefined {
  return db.prepare(`SELECT * FROM hosts WHERE name = ? COLLATE NOCASE AND status = 'active'`).get(name) as
    | HostRow
    | undefined;
}

export function listHosts(): HostRow[] {
  return db.prepare(`SELECT * FROM hosts ORDER BY created_at DESC`).all() as HostRow[];
}

export function listActiveHosts(): HostRow[] {
  return db.prepare(`SELECT * FROM hosts WHERE status = 'active' ORDER BY name`).all() as HostRow[];
}

export function revokeHost(id: string): void {
  db.prepare(`UPDATE hosts SET status = 'revoked', revoked_at = ? WHERE id = ?`).run(Date.now(), id);
}

export function touchHost(id: string): void {
  db.prepare(`UPDATE hosts SET last_seen = ? WHERE id = ?`).run(Date.now(), id);
}

export function verifyDevice(deviceId: string, deviceSecret: string): HostRow | null {
  const host = getHostById(deviceId);
  if (!host || host.status !== "active") return null;
  if (host.secret_hash !== sha256(deviceSecret)) return null;
  return host;
}

// --- ACLs ---

export interface AclRow {
  slack_user_id: string;
  granted_by: string | null;
  granted_at: number | null;
}

export function hasAcl(hostId: string, slackUserId: string): boolean {
  return !!db.prepare(`SELECT 1 FROM acls WHERE host_id = ? AND slack_user_id = ?`).get(hostId, slackUserId);
}

export function addAcl(hostId: string, slackUserId: string, grantedBy: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO acls (host_id, slack_user_id, granted_by, granted_at) VALUES (?, ?, ?, ?)`,
  ).run(hostId, slackUserId, grantedBy, Date.now());
}

export function removeAcl(hostId: string, slackUserId: string): void {
  db.prepare(`DELETE FROM acls WHERE host_id = ? AND slack_user_id = ?`).run(hostId, slackUserId);
}

export function listAcls(hostId: string): string[] {
  return (db.prepare(`SELECT slack_user_id FROM acls WHERE host_id = ?`).all(hostId) as { slack_user_id: string }[]).map(
    (r) => r.slack_user_id,
  );
}

export function listAclsDetailed(hostId: string): AclRow[] {
  return db
    .prepare(`SELECT slack_user_id, granted_by, granted_at FROM acls WHERE host_id = ? ORDER BY granted_at`)
    .all(hostId) as AclRow[];
}

/** Active hosts whose owner is this Slack user (usually one machine). */
export function hostsOwnedBy(slackUserId: string): HostRow[] {
  return db
    .prepare(`SELECT * FROM hosts WHERE owner_slack_id = ? AND status = 'active' ORDER BY name`)
    .all(slackUserId) as HostRow[];
}

export function setDailyLimit(hostId: string, limit: number | null): void {
  db.prepare(`UPDATE hosts SET daily_limit = ? WHERE id = ?`).run(limit, hostId);
}

/** Hosts a given Slack user is allowed to query. */
export function hostsForUser(slackUserId: string, isAdmin: boolean): HostRow[] {
  if (isAdmin) return listActiveHosts();
  return db
    .prepare(
      `SELECT h.* FROM hosts h JOIN acls a ON a.host_id = h.id
       WHERE a.slack_user_id = ? AND h.status = 'active' ORDER BY h.name`,
    )
    .all(slackUserId) as HostRow[];
}

// --- threads & DM stickiness ---

export function bindThread(threadKey: string, hostId: string, createdBy: string): void {
  db.prepare(
    `INSERT INTO threads (thread_key, host_id, created_by, created_at, last_active)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(thread_key) DO UPDATE SET last_active = excluded.last_active`,
  ).run(threadKey, hostId, createdBy, Date.now(), Date.now());
}

export function getThread(threadKey: string): ThreadRow | undefined {
  return db.prepare(`SELECT * FROM threads WHERE thread_key = ?`).get(threadKey) as ThreadRow | undefined;
}

export function setThreadSession(threadKey: string, sdkSessionId: string): void {
  db.prepare(`UPDATE threads SET sdk_session_id = ?, last_active = ? WHERE thread_key = ?`).run(
    sdkSessionId,
    Date.now(),
    threadKey,
  );
}

export function clearThread(threadKey: string): void {
  db.prepare(`DELETE FROM threads WHERE thread_key = ?`).run(threadKey);
}

export function getDmHost(channel: string): string | null {
  const row = db.prepare(`SELECT host_id FROM dm_prefs WHERE channel = ?`).get(channel) as
    | { host_id: string }
    | undefined;
  return row?.host_id ?? null;
}

export function setDmHost(channel: string, hostId: string): void {
  db.prepare(
    `INSERT INTO dm_prefs (channel, host_id, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(channel) DO UPDATE SET host_id = excluded.host_id, updated_at = excluded.updated_at`,
  ).run(channel, hostId, Date.now());
}

export function clearDmHost(channel: string): void {
  db.prepare(`DELETE FROM dm_prefs WHERE channel = ?`).run(channel);
}

// --- transcripts & usage ---

export function addTranscript(
  threadKey: string,
  hostId: string,
  askerSlackId: string,
  role: "user" | "assistant" | "system",
  content: string,
): void {
  db.prepare(
    `INSERT INTO transcripts (thread_key, host_id, asker_slack_id, role, content, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(threadKey, hostId, askerSlackId, role, content, Date.now());
}

export function listRecentThreads(limit = 100): (ThreadRow & { host_name: string; messages: number })[] {
  return db
    .prepare(
      `SELECT t.*, h.name AS host_name,
              (SELECT COUNT(*) FROM transcripts x WHERE x.thread_key = t.thread_key) AS messages
       FROM threads t JOIN hosts h ON h.id = t.host_id
       ORDER BY t.last_active DESC LIMIT ?`,
    )
    .all(limit) as (ThreadRow & { host_name: string; messages: number })[];
}

export function listRecentThreadsForHost(hostId: string, limit = 50): (ThreadRow & { messages: number })[] {
  return db
    .prepare(
      `SELECT t.*, (SELECT COUNT(*) FROM transcripts x WHERE x.thread_key = t.thread_key) AS messages
       FROM threads t WHERE t.host_id = ? ORDER BY t.last_active DESC LIMIT ?`,
    )
    .all(hostId, limit) as (ThreadRow & { messages: number })[];
}

export function getTranscript(threadKey: string): TranscriptRow[] {
  return db
    .prepare(`SELECT * FROM transcripts WHERE thread_key = ? ORDER BY id`)
    .all(threadKey) as TranscriptRow[];
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function bumpUsage(hostId: string): void {
  db.prepare(
    `INSERT INTO usage (host_id, day, count) VALUES (?, ?, 1)
     ON CONFLICT(host_id, day) DO UPDATE SET count = count + 1`,
  ).run(hostId, today());
}

export function usageToday(hostId: string): number {
  const row = db.prepare(`SELECT count FROM usage WHERE host_id = ? AND day = ?`).get(hostId, today()) as
    | { count: number }
    | undefined;
  return row?.count ?? 0;
}
