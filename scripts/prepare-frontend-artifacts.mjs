#!/usr/bin/env node
/**
 * Prepare frontend runtime artifacts: build scanner WASM, fetch circuit assets, verify hashes.
 * Set SKIP_FRONTEND_PREBUILD=1 when CI already built/downloaded artifacts.
 */

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

if (process.env.SKIP_FRONTEND_PREBUILD === "1") {
  console.log("SKIP_FRONTEND_PREBUILD=1 — skipping prepare-frontend-artifacts");
  process.exit(0);
}

function run(label, cmd, args, opts = {}) {
  console.log(`\n> ${label}`);
  const result = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
    ...opts,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run("Build scanner WASM", "node", ["scripts/build-scanner-wasm.mjs"]);

// Best-effort fetch; build continues when release assets are not published yet.
const fetchResult = spawnSync("node", ["scripts/fetch-circuit-artifacts.mjs"], {
  cwd: ROOT,
  stdio: "inherit",
  env: process.env,
});
if (fetchResult.status !== 0) {
  console.warn("Circuit artifact fetch skipped or incomplete (build locally or publish release assets).");
}

run("Verify pinned artifact hashes", "node", [
  "scripts/verify-artifact-manifest.mjs",
  "--scanner",
  "--strict",
]);

// Fail build when circuit files are present but hashes drift from manifest.
run("Verify circuit artifacts when present", "node", [
  "scripts/verify-artifact-manifest.mjs",
  "--circuits",
  "--vk-binding",
]);
