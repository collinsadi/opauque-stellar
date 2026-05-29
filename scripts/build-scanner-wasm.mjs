#!/usr/bin/env node
/**
 * Build scanner WASM via wasm-pack into frontend/public/pkg.
 */

import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SCANNER = join(ROOT, "scanner");
const OUT = join(ROOT, "frontend", "public", "pkg");

function main() {
  const wasmPack = process.env.WASM_PACK ?? "wasm-pack";
  const args = ["build", "--target", "web", "--out-dir", OUT];
  console.log(`> cd scanner && ${wasmPack} ${args.join(" ")}`);

  const result = spawnSync(wasmPack, args, {
    cwd: SCANNER,
    stdio: "inherit",
    env: process.env,
  });

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  console.log(`Scanner WASM ready at ${OUT}`);
}

main();
