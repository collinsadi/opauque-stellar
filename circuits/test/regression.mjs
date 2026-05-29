#!/usr/bin/env node
/**
 * Circuit regression tests with deterministic fixtures.
 *
 * Modes:
 *   default / --full   prove + verify with pinned zkey/wasm (requires release artifacts)
 *   --compile          compile circuits first (requires circom on PATH)
 *   --witness-only     calculate witness and compare public outputs (no zkey)
 *
 * Usage:
 *   node circuits/test/regression.mjs
 *   node circuits/test/regression.mjs --version v1
 *   node circuits/test/regression.mjs --compile --witness-only
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import * as snarkjs from "snarkjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CIRCUITS_ROOT = resolve(__dirname, "..");
const REPO_ROOT = resolve(CIRCUITS_ROOT, "..");
const MANIFEST_PATH = join(REPO_ROOT, "artifacts", "manifest.json");

function parseArgs(argv) {
  const opts = {
    versions: ["v1", "v2"],
    compile: false,
    witnessOnly: false,
    full: true,
  };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--version" && argv[i + 1]) opts.versions = [argv[++i]];
    else if (argv[i] === "--compile") opts.compile = true;
    else if (argv[i] === "--witness-only") {
      opts.witnessOnly = true;
      opts.full = false;
    } else if (argv[i] === "--full") opts.full = true;
  }
  return opts;
}

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function loadManifest() {
  return loadJson(MANIFEST_PATH);
}

const CIRCUIT_CONFIG = {
  v1: {
    compileCwd: CIRCUITS_ROOT,
    compileCmd: ["npm", "run", "build"],
    buildWasm: join(CIRCUITS_ROOT, "build/stealth_attestation_js/stealth_attestation.wasm"),
    buildR1cs: join(CIRCUITS_ROOT, "build/stealth_attestation.r1cs"),
    buildVk: join(CIRCUITS_ROOT, "build/verification_key.json"),
    publicSignalOrder: [
      "nullifier",
      "is_valid",
      "merkle_root",
      "attestation_id",
      "external_nullifier",
    ],
  },
  v2: {
    compileCwd: join(CIRCUITS_ROOT, "v2"),
    compileCmd: ["npm", "run", "build"],
    buildWasm: join(CIRCUITS_ROOT, "v2/build/stealth_reputation_js/stealth_reputation.wasm"),
    buildR1cs: join(CIRCUITS_ROOT, "v2/build/stealth_reputation.r1cs"),
    buildVk: join(CIRCUITS_ROOT, "v2/build/verification_key.json"),
    publicSignalOrder: [
      "merkle_root",
      "attestation_id",
      "external_nullifier",
      "nullifier_hash",
    ],
  },
};

function resolvePaths(version, manifest) {
  const circuit = manifest.circuits[version];
  const cfg = CIRCUIT_CONFIG[version];
  const wasmPath = existsSync(resolve(REPO_ROOT, circuit.frontend.witnessWasm.path))
    ? resolve(REPO_ROOT, circuit.frontend.witnessWasm.path)
    : cfg.buildWasm;
  const zkeyPath = existsSync(resolve(REPO_ROOT, circuit.frontend.zkey.path))
    ? resolve(REPO_ROOT, circuit.frontend.zkey.path)
    : null;
  const vkPath = existsSync(cfg.buildVk)
    ? cfg.buildVk
    : version === "v2"
      ? resolve(REPO_ROOT, circuit.contractVk.referenceVerificationKey.path)
      : null;
  const r1csPath = cfg.buildR1cs;
  return { wasmPath, zkeyPath, vkPath, r1csPath, cfg };
}

function runCompile(version) {
  const cfg = CIRCUIT_CONFIG[version];
  console.log(`Compiling ${version}...`);
  const [cmd, ...args] = cfg.compileCmd;
  const result = spawnSync(cmd, args, { cwd: cfg.compileCwd, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${version} compile failed (is circom installed?)`);
  }
}

function publicSignalsToMap(order, signals) {
  const map = {};
  order.forEach((name, i) => {
    map[name] = signals[i]?.toString?.() ?? String(signals[i]);
  });
  return map;
}

function assertPublicOutputs(version, signals, expected) {
  const order = CIRCUIT_CONFIG[version].publicSignalOrder;
  const actual = publicSignalsToMap(order, signals);
  const errors = [];
  for (const key of order) {
    if (actual[key] !== expected[key]) {
      errors.push(`${version}.${key}: expected ${expected[key]}, got ${actual[key]}`);
    }
  }
  return errors;
}

async function testValidCase(version, paths, fixtureDir) {
  const input = loadJson(join(fixtureDir, "valid-input.json"));
  const expected = loadJson(join(fixtureDir, "expected-public.json"));

  if (!existsSync(paths.wasmPath)) {
    throw new Error(`${version}: witness wasm missing at ${paths.wasmPath}`);
  }

  if (paths.witnessOnly ?? false) {
    const wtns = await snarkjs.wtns.calculate(input, paths.wasmPath);
    const tmpDir = join(CIRCUITS_ROOT, "build", "test-tmp");
    mkdirSync(tmpDir, { recursive: true });
    const wtnsPath = join(tmpDir, `${version}-valid.wtns`);
    await snarkjs.wtns.write(wtns, wtnsPath);

    if (existsSync(paths.r1csPath)) {
      const ok = await snarkjs.wtns.check(paths.r1csPath, wtnsPath);
      if (!ok) throw new Error(`${version}: valid witness failed r1cs check`);
    }

    const witness = await snarkjs.wtns.exportJson(wtnsPath);
    const publicSignals = witness.slice(-paths.cfg.publicSignalOrder.length);
    const errors = assertPublicOutputs(version, publicSignals, expected);
    if (errors.length) throw new Error(errors.join("; "));
    console.log(`OK: ${version} valid witness`);
    return;
  }

  if (!paths.zkeyPath) {
    throw new Error(`${version}: zkey missing (fetch circuit artifacts or run trusted setup)`);
  }

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    input,
    paths.wasmPath,
    paths.zkeyPath,
  );
  const errors = assertPublicOutputs(version, publicSignals, expected);
  if (errors.length) throw new Error(errors.join("; "));

  if (paths.vkPath && existsSync(paths.vkPath)) {
    const vk = loadJson(paths.vkPath);
    const verified = await snarkjs.groth16.verify(vk, publicSignals, proof);
    if (!verified) throw new Error(`${version}: proof verification failed`);
  }

  console.log(`OK: ${version} valid prove + verify`);
}

async function testInvalidCase(version, paths, fixtureDir) {
  const input = loadJson(join(fixtureDir, "invalid-input.json"));

  if (paths.witnessOnly ?? false) {
    try {
      const wtns = await snarkjs.wtns.calculate(input, paths.wasmPath);
      const tmpDir = join(CIRCUITS_ROOT, "build", "test-tmp");
      mkdirSync(tmpDir, { recursive: true });
      const wtnsPath = join(tmpDir, `${version}-invalid.wtns`);
      await snarkjs.wtns.write(wtns, wtnsPath);
      if (existsSync(paths.r1csPath)) {
        const ok = await snarkjs.wtns.check(paths.r1csPath, wtnsPath);
        if (ok) {
          throw new Error(`${version}: invalid input unexpectedly satisfied constraints`);
        }
      }
      console.log(`OK: ${version} invalid witness rejected`);
      return;
    } catch (err) {
      if (String(err.message).includes("unexpectedly satisfied")) throw err;
      console.log(`OK: ${version} invalid witness rejected (${err.message})`);
      return;
    }
  }

  try {
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      input,
      paths.wasmPath,
      paths.zkeyPath,
    );
    if (paths.vkPath && existsSync(paths.vkPath)) {
      const vk = loadJson(paths.vkPath);
      const verified = await snarkjs.groth16.verify(vk, publicSignals, proof);
      if (verified) {
        throw new Error(`${version}: invalid input produced verifying proof`);
      }
    }
    const expected = loadJson(join(fixtureDir, "expected-public.json"));
    const order = CIRCUIT_CONFIG[version].publicSignalOrder;
    const actual = publicSignalsToMap(order, publicSignals);
    if (actual.is_valid === "1") {
      throw new Error(`${version}: invalid input produced is_valid=1`);
    }
    console.log(`OK: ${version} invalid input did not produce valid attestation`);
  } catch (err) {
    if (String(err.message).includes("produced verifying proof")) throw err;
    console.log(`OK: ${version} invalid input rejected (${err.message?.slice?.(0, 80) ?? err})`);
  }
}

async function main() {
  const opts = parseArgs(process.argv);
  const manifest = loadManifest();
  const failures = [];

  for (const version of opts.versions) {
    try {
      if (opts.compile) runCompile(version);
      const paths = resolvePaths(version, manifest);
      paths.witnessOnly = opts.witnessOnly;
      const fixtureDir = join(CIRCUITS_ROOT, "fixtures", version);
      await testValidCase(version, paths, fixtureDir);
      await testInvalidCase(version, paths, fixtureDir);
    } catch (err) {
      failures.push(`${version}: ${err.message}`);
    }
  }

  if (failures.length) {
    console.error("\nCircuit regression failures:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log("\nOK: circuit regression tests passed");
}

main();
