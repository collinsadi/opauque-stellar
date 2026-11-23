/**
 * Byte-stability check for scanner WASM rebuilds.
 *
 * Rebuilds the scanner WASM using the pinned toolchain (scanner/rust-toolchain.toml),
 * computes its SHA-256, and compares it against the single pinned hash in
 * artifacts/manifest.json. The build must be byte-identical — no alternates
 * are accepted.
 *
 * Usage:
 *   npx tsx scripts/check-scanner-byte-stability.ts
 */

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadManifest, sha256File } from "./artifact-manifest-lib.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SCANNER = join(ROOT, "scanner");
const OUT = join(ROOT, "frontend", "public", "pkg");

function canRun(cmd, args = [], env = process.env) {
  const result = spawnSync(cmd, args, { cwd: ROOT, stdio: "ignore", env });
  return !result.error && result.status === 0;
}

function run(label, cmd, args, opts = {}) {
  console.log(`\n> ${label}`);
  const result = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
    ...opts,
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function main() {
  console.log("=== Scanner WASM Byte-Stability Check ===\n");

  // Step 1: Rebuild the scanner using the pinned toolchain.
  // --mode no-install prevents wasm-pack from overriding the
  // Rust version pinned in scanner/rust-toolchain.toml.
  const wasmPack = process.env.WASM_PACK ?? "wasm-pack";
  const mode = process.env.WASM_PACK_MODE ?? (canRun("wasm-bindgen", ["--version"]) ? "no-install" : "normal");
  const buildArgs = ["build", "--target", "web", "--out-dir", OUT, "--mode", mode];
  run(`Rebuilding scanner WASM (pinned toolchain)`, wasmPack, buildArgs, { cwd: SCANNER });

  // Step 2: Load manifest
  const manifest = loadManifest();
  const scannerFiles = manifest.scanner?.files ?? {};
  const wasmEntry = scannerFiles["opauque_scanner_bg.wasm"];

  if (!wasmEntry) {
    console.error("ERROR: opauque_scanner_bg.wasm not found in artifact manifest");
    process.exit(1);
  }

  const expectedHash = wasmEntry.sha256;
  const wasmPath = join(ROOT, wasmEntry.path);

  if (!existsSync(wasmPath)) {
    console.error(`ERROR: Built WASM not found at ${wasmPath}`);
    process.exit(1);
  }

  // Step 3: Compute actual hash
  const actualHash = sha256File(wasmPath);

  // Step 4: Compare against the single pinned hash
  console.log(`\n--- Results ---`);
  console.log(`File:              ${wasmEntry.path}`);
  console.log(`Pinned SHA-256:    ${expectedHash}`);
  console.log(`Built SHA-256:     ${actualHash}`);

  if (actualHash === expectedHash) {
    console.log(`\n✅ IDENTICAL — Built artifact matches the pinned manifest hash.`);
    console.log(`   Hash: ${actualHash}`);
    process.exit(0);
  }

  console.log(`\n❌ DIFFERENT — Built artifact does NOT match the pinned manifest hash.`);
  console.log(`\nPinned hash: ${expectedHash}`);
  console.log(`Built hash:  ${actualHash}`);
  console.log(`\nThe scanner WASM must be byte-reproducible from the pinned toolchain.`);
  console.log(`Ensure you are using: rustup run 1.94.1 (via rust-toolchain.toml)`);
  console.log(`and wasm-pack --mode no-install.`);

  console.log(`\n--- Manifest Update Procedure ---`);
  console.log(`If the toolchain was intentionally upgraded, run:`);
  console.log(`\n  npm run update:artifacts\n`);
  console.log(`This will update artifacts/manifest.json with the current artifact hashes.`);
  console.log(`After updating, verify with: npm run verify:artifacts -- --scanner`);
  console.log(`Then commit the updated manifest and WASM artifact together.`);

  process.exit(1);
}

main();
