import { build } from "esbuild";

const common = {
  bundle: true,
  platform: "node",
  target: "node20",
  logLevel: "info",
};

// Main process: ESM. The daemon + shared workspace code is bundled in;
// the Agent SDK stays external (it spawns its own bundled CLI from disk).
await build({
  ...common,
  entryPoints: ["src/main.ts"],
  format: "esm",
  outfile: "dist/main.js",
  external: ["electron", "@anthropic-ai/claude-agent-sdk", "bufferutil", "utf-8-validate"],
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});

// Preload: must be CommonJS for the sandboxed renderer.
await build({
  ...common,
  entryPoints: ["src/preload.ts"],
  format: "cjs",
  outfile: "dist/preload.cjs",
  external: ["electron"],
});
