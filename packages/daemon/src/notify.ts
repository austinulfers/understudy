import { execFile } from "node:child_process";
import type { QueryEvent } from "./events";

/** One line saying who is asking, for the heads-up shown when a question starts. */
export function queryNotice(event: QueryEvent): string {
  return event.viaHost
    ? `${event.viaHost}'s agent is asking your agent a question for ${event.askerName}`
    : `${event.askerName} is asking your agent a question`;
}

/**
 * Desktop heads-up for the CLI, so the owner always knows their agent is being
 * used. macOS files an osascript notification under Script Editor, icon and
 * all, which is why the menu-bar app posts its own through Electron instead.
 */
export function notifyOwner(title: string, body: string): void {
  if (process.platform !== "darwin") return;
  const script = `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`;
  execFile("osascript", ["-e", script], () => {});
}
