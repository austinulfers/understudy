import * as path from "node:path";
import * as os from "node:os";

/**
 * Path containment for read-only sessions. A tool call is allowed only if
 * every path it touches resolves inside one of the owner's exposed roots
 * AND matches no deny pattern. Checked in the daemon's canUseTool hook —
 * a second gate behind the SDK's own tool allowlist.
 */

/** Basenames that are never readable, even inside an exposed root. */
export const DENY_BASENAMES: string[] = [
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  // Apple: App Store Connect API keys and APNs auth keys.
  "*.p8",
  "*.p12",
  "*.pfx",
  "*.keystore",
  "*.keychain",
  "id_rsa*",
  "id_ecdsa*",
  "id_ed25519*",
  ".npmrc",
  ".netrc",
  ".pgpass",
  "credentials",
  "credentials.json",
  "service-account*.json",
  "secrets.*",
];

/** Directory segments that are never traversable. */
export const DENY_DIR_SEGMENTS: string[] = [
  ".ssh",
  ".aws",
  ".gnupg",
  ".gcloud",
  ".config/gcloud",
  ".kube",
  ".docker",
  ".claude",
  ".understudy",
  // The daemon's config directory under its pre-rename name.
  ".workspace-agent",
];

export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

const DENY_BASENAME_RES = DENY_BASENAMES.map(wildcardToRegExp);

export interface PathVerdict {
  allowed: boolean;
  reason?: string;
}

/**
 * @param cwd Where a relative path is taken to start: the session's own
 *   working directory (its primary root), not this process's, which can be
 *   anywhere and would make the check disagree with what the tool reads.
 */
export function checkPath(rawPath: string, roots: string[], cwd: string = process.cwd()): PathVerdict {
  const resolved = path.resolve(cwd, expandHome(rawPath));

  const inRoot = roots.some((root) => {
    const r = path.resolve(expandHome(root));
    return resolved === r || resolved.startsWith(r + path.sep);
  });
  if (!inRoot) {
    return { allowed: false, reason: `${resolved} is outside the exposed directories` };
  }

  const segments = resolved.split(path.sep).filter(Boolean);
  for (const segment of segments) {
    if (DENY_DIR_SEGMENTS.includes(segment)) {
      return { allowed: false, reason: `path contains protected directory "${segment}"` };
    }
  }

  const base = path.basename(resolved);
  for (const re of DENY_BASENAME_RES) {
    if (re.test(base)) {
      return { allowed: false, reason: `"${base}" matches the secret deny-list` };
    }
  }

  return { allowed: true };
}

/**
 * Extract every filesystem path present in a tool call's input, so callers
 * can vet all of them. Covers the read-only toolset (Read / Grep / Glob).
 */
export function extractToolPaths(toolName: string, input: Record<string, unknown>): string[] {
  const paths: string[] = [];
  const candidates = ["file_path", "path", "notebook_path"];
  for (const key of candidates) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) paths.push(value);
  }
  // A glob/grep pattern that is absolute, or climbs out of the working
  // directory, is itself a path escape attempt: vet its literal prefix.
  const pattern = input["pattern"];
  if (typeof pattern === "string") {
    const climbs = pattern.split(/[\\/]/).includes("..");
    if (pattern.startsWith("/") || pattern.startsWith("~") || climbs) {
      paths.push(pattern.replace(/[*?[{].*$/, "") || "/");
    }
  }
  return paths;
}
