// Recompute the sha512 and size of every file an electron-builder update
// manifest (latest-mac.yml) lists, from the files on disk beside it.
//
// electron-builder hashes each artifact the moment it is built. The release
// workflow then signs, notarizes, and staples the DMG, which rewrites its
// bytes, so the DMG's entry goes stale. electron-updater on macOS only ever
// downloads the zip, but a manifest that lies about a file it lists is a
// trap for whoever reads it next.
//
//   node update-manifest.mjs release/latest-mac.yml           rewrite in place
//   node update-manifest.mjs release/latest-mac.yml --check   fail if anything is stale
//
// No YAML parser: the manifest is js-yaml output with a fixed shape, and pnpm
// does not expose electron-builder's own js-yaml to this package.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const [manifest, flag] = process.argv.slice(2);
if (!manifest || (flag !== undefined && flag !== "--check")) {
  console.error("usage: node update-manifest.mjs <latest-mac.yml> [--check]");
  process.exit(2);
}
const check = flag === "--check";
const dir = path.dirname(manifest);

const unquote = (value) => value.replace(/^(['"])(.*)\1$/, "$2");

async function sha512(file) {
  const hash = createHash("sha512");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("base64");
}

const lines = fs.readFileSync(manifest, "utf8").split("\n");
let file = null; // the artifact that the sha512/size lines which follow describe
const stale = [];
for (let i = 0; i < lines.length; i++) {
  // `- url:` entries under `files:`, and the top-level `path:` for the primary artifact.
  const named = /^(?:\s*-\s+url|path):\s*(.+?)\s*$/.exec(lines[i]);
  if (named) {
    const name = unquote(named[1]);
    file = path.join(dir, name);
    if (!fs.existsSync(file)) {
      console.error(`${manifest} lists ${name}, which is not in ${dir}`);
      process.exit(1);
    }
    continue;
  }
  const field = /^(\s*)(sha512|size):\s*(.+?)\s*$/.exec(lines[i]);
  if (!field || !file) continue;
  const [, indent, key, current] = field;
  const actual = key === "size" ? String(fs.statSync(file).size) : await sha512(file);
  if (actual === unquote(current)) continue;
  stale.push(`${path.basename(file)} ${key}`);
  lines[i] = `${indent}${key}: ${actual}`;
}

if (stale.length === 0) {
  console.log(`${manifest}: every entry matches the file on disk`);
} else if (check) {
  console.error(`${manifest} is stale: ${stale.join(", ")}`);
  process.exit(1);
} else {
  fs.writeFileSync(manifest, lines.join("\n"));
  console.log(`${manifest}: refreshed ${stale.join(", ")}`);
}
