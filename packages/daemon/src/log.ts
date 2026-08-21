import * as fs from "node:fs";
import * as path from "node:path";
import { LOG_DIR } from "./config";

/**
 * Local mirror of everything that runs on this machine, so the host owner
 * never has to trust the broker's audit log alone.
 */
export function logLocal(entry: Record<string, unknown>): void {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
    const file = path.join(LOG_DIR, `${new Date().toISOString().slice(0, 10)}.jsonl`);
    fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
  } catch (err) {
    console.error("[log] failed to write local log", err);
  }
}
