import { execFile } from "node:child_process";

/** Desktop heads-up so the owner always knows their agent is being used. */
export function notifyOwner(title: string, body: string): void {
  if (process.platform !== "darwin") return;
  const script = `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`;
  execFile("osascript", ["-e", script], () => {});
}
