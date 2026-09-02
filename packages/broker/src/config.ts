function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

export const config = {
  slackBotToken: required("SLACK_BOT_TOKEN"),
  slackAppToken: required("SLACK_APP_TOKEN"),
  /** Protects the admin dashboard (HTTP basic auth, user "admin"). */
  adminToken: required("ADMIN_TOKEN"),
  /** Slack user IDs that bypass per-host ACLs (comma-separated). */
  adminSlackIds: (process.env.ADMIN_SLACK_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  port: Number(process.env.PORT ?? 8787),
  dbPath: process.env.DB_PATH ?? "./workspace-agent.db",
  /** Queries per host per day unless the host row overrides it. */
  defaultDailyLimit: Number(process.env.DEFAULT_DAILY_LIMIT ?? 50),
  /** Queries per asker per minute across all hosts. */
  askerRatePerMinute: Number(process.env.ASKER_RATE_PER_MINUTE ?? 6),
  /** Broker-side cap on a single query's wall time. */
  queryTimeoutMs: Number(process.env.QUERY_TIMEOUT_MS ?? 6 * 60 * 1000),
  /**
   * How many other hosts' agents one answer may consult. Each consultation
   * spends the consulted host's daily budget. 0 withholds the tool; agents
   * still learn who else exists.
   */
  peerAsksPerQuery: Number(process.env.PEER_ASKS_PER_QUERY ?? 3),
  /** Wall-time cap on a question one agent asks another. */
  peerQueryTimeoutMs: Number(process.env.PEER_QUERY_TIMEOUT_MS ?? 3 * 60 * 1000),
  /**
   * Optional channel ID. When set, DM-initiated queries post a one-line
   * breadcrumb there so private queries stay socially visible.
   */
  breadcrumbChannel: process.env.BREADCRUMB_CHANNEL ?? null,
};
