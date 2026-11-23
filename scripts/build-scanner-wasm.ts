/**
 * Build scanner WASM via wasm-pack into frontend/public/pkg.
 */

import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SCANNER = join(ROOT, "scanner");
const OUT = join(ROOT, "frontend", "public", "pkg");
const LOCAL_BIN = join(ROOT, ".bin");

function canRun(cmd, args = [], env = process.env) {
  const result = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: "ignore",
    env,
  });
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

function maybeBootstrapToolchain(wasmPack, env) {
  if (canRun(wasmPack, ["--version"], env)) return { wasmPack, env };

  const shouldBootstrap =
    process.env.OPAQUE_BOOTSTRAP_WASM_PACK === "1" ||
    process.env.RENDER === "true" ||
    process.env.RENDER_SERVICE_ID;

  if (!shouldBootstrap) {
    console.error(
      "wasm-pack is required to build scanner WASM. Install wasm-pack 0.14.0 or set OPAQUE_BOOTSTRAP_WASM_PACK=1 to install local build tooling.",
    );
    process.exit(1);
  }

  mkdirSync(LOCAL_BIN, { recursive: true });
  const homeCargo = join(process.env.HOME ?? "", ".cargo", "bin");
  const bootEnv = {
    ...env,
    PATH: `${LOCAL_BIN}:${homeCargo}:${env.PATH ?? ""}`,
    WASM_PACK_INSTALL_DIR: LOCAL_BIN,
  };

  if (!canRun("cargo", ["--version"], bootEnv)) {
    run("Install Rust toolchain", "sh", [
      "-c",
      "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --target wasm32-unknown-unknown",
    ], { env: bootEnv });
  }

  if (canRun("rustup", ["--version"], bootEnv)) {
    run("Install wasm32 target", "rustup", ["target", "add", "wasm32-unknown-unknown"], {
      env: bootEnv,
    });
  }

  run("Install wasm-pack", "bash", ["scripts/install-wasm-pack.sh"], { env: bootEnv });

  const localWasmPack = join(LOCAL_BIN, "wasm-pack");
  if (!canRun(localWasmPack, ["--version"], bootEnv)) {
    console.error("wasm-pack installation did not produce a runnable binary");
    process.exit(1);
  }

  return { wasmPack: localWasmPack, env: bootEnv };
}

function main() {
  let wasmPack = process.env.WASM_PACK ?? "wasm-pack";
  let env = process.env;
  ({ wasmPack, env } = maybeBootstrapToolchain(wasmPack, env));

  const mode = process.env.WASM_PACK_MODE ?? (canRun("wasm-bindgen", ["--version"], env) ? "no-install" : "normal");
  const args = ["build", "--target", "web", "--out-dir", OUT, "--mode", mode];
  console.log(`> cd scanner && ${wasmPack} ${args.join(" ")}`);

  const result = spawnSync(wasmPack, args, {
    cwd: SCANNER,
    stdio: "inherit",
    env,
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
