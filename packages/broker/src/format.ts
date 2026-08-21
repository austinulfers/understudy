/** Best-effort conversion of the agent's markdown to Slack mrkdwn. */
export function mdToMrkdwn(text: string): string {
  return (
    text
      // [label](url) -> <url|label>
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "<$2|$1>")
      // **bold** / __bold__ -> *bold*
      .replace(/\*\*([^*]+)\*\*/g, "*$1*")
      .replace(/__([^_]+)__/g, "*$1*")
      // # headings -> bold lines
      .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
      // - bullets -> • bullets
      .replace(/^(\s*)-\s+/gm, "$1• ")
  );
}

const SLACK_MSG_LIMIT = 3800;

/** Split long answers into Slack-sized chunks, preferring paragraph breaks. */
export function chunkForSlack(text: string): string[] {
  if (text.length <= SLACK_MSG_LIMIT) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > SLACK_MSG_LIMIT) {
    let cut = rest.lastIndexOf("\n\n", SLACK_MSG_LIMIT);
    if (cut < SLACK_MSG_LIMIT / 2) cut = rest.lastIndexOf("\n", SLACK_MSG_LIMIT);
    if (cut < SLACK_MSG_LIMIT / 2) cut = SLACK_MSG_LIMIT;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export function formatLastSeen(lastSeen: number | null): string {
  if (!lastSeen) return "never seen";
  const mins = Math.round((Date.now() - lastSeen) / 60000);
  if (mins < 1) return "seen just now";
  if (mins < 60) return `last seen ${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `last seen ${hours}h ago`;
  return `last seen ${Math.round(hours / 24)}d ago`;
}
