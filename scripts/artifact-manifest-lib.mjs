#!/usr/bin/env node
/**
 * Shared helpers for artifact manifest read/update/verify.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(__dirname, "..");
export const MANIFEST_PATH = join(ROOT, "artifacts", "manifest.json");

const SHA256_HEX = /^[a-f0-9]{64}$/;

export function loadManifest() {
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
}

export function saveManifest(manifest) {
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
}

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function sha256Buffer(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

export function resolveArtifactPath(relPath) {
  return join(ROOT, relPath);
}

export function isSetHash(hash) {
  return typeof hash === "string" && SHA256_HEX.test(hash);
}

/**
 * Walk manifest artifact entries that carry { path, sha256 }.
 */
export function* iterArtifactEntries(manifest, { includeNull = false } = {}) {
  for (const [name, entry] of Object.entries(manifest.scanner?.files ?? {})) {
    yield { group: "scanner", name, ...entry };
  }

  for (const version of ["v1", "v2"]) {
    const circuit = manifest.circuits?.[version];
    if (!circuit) continue;

    for (const [name, entry] of Object.entries(circuit.frontend ?? {})) {
      yield { group: `circuits.${version}.frontend`, name, ...entry };
    }
    for (const [name, entry] of Object.entries(circuit.build ?? {})) {
      yield { group: `circuits.${version}.build`, name, ...entry };
    }

    const ref = circuit.contractVk?.referenceVerificationKey;
    if (ref) {
      yield {
        group: `circuits.${version}.contractVk`,
        name: "referenceVerificationKey",
        path: ref.path,
        sha256: ref.sha256,
      };
    }
  }
}

export function verifyEntry(entry, { strict = true, label = entry.path } = {}) {
  const errors = [];
  const fullPath = resolveArtifactPath(entry.path);

  if (!isSetHash(entry.sha256)) {
    if (strict) {
      errors.push(`${label}: sha256 not set in manifest (run update-artifact-manifest.mjs)`);
    }
    return { errors, skipped: true };
  }

  if (!existsSync(fullPath)) {
    if (strict) {
      errors.push(`${label}: file missing at ${entry.path}`);
    }
    return { errors, missing: true, skipped: !strict };
  }

  const actual = sha256File(fullPath);
  if (actual !== entry.sha256) {
    errors.push(`${label}: hash mismatch manifest=${entry.sha256} actual=${actual}`);
  }

  return { errors, actual };
}

/**
 * Extract VK_* byte arrays from groth16-verifier lib.rs and hash concatenated bytes.
 */
export function hashEmbeddedContractVk(libRsPath, { v2 = false } = {}) {
  const source = readFileSync(resolveArtifactPath(libRsPath), "utf8");

  const pointNames = v2
    ? ["VK_ALPHA_V2", "VK_BETA_V2", "VK_GAMMA_V2", "VK_DELTA_V2"]
    : ["VK_ALPHA", "VK_BETA", "VK_GAMMA", "VK_DELTA"];

  const icName = v2 ? "VK_IC_V2" : "VK_IC";
  const chunks = [];

  for (const name of pointNames) {
    const blockRe = new RegExp(`const ${name}: \\[[^\\]]+\\] = \\[([\\s\\S]*?)\\];`, "m");
    const match = source.match(blockRe);
    if (!match) throw new Error(`Could not find ${name} in ${libRsPath}`);
    chunks.push(extractBytes(match[1]));
  }

  const icRe = new RegExp(`const ${icName}: \\[\\[u8; 64\\]; \\d+\\] = \\[([\\s\\S]*?)\\];`, "m");
  const icMatch = source.match(icRe);
  if (!icMatch) throw new Error(`Could not find ${icName} in ${libRsPath}`);
  chunks.push(extractBytes(icMatch[1]));

  return sha256Buffer(Buffer.concat(chunks));
}

function extractBytes(arrayBody) {
  const bytes = [];
  const re = /0x([0-9a-fA-F]{2})/g;
  let m;
  while ((m = re.exec(arrayBody)) !== null) {
    bytes.push(parseInt(m[1], 16));
  }
  return Buffer.from(bytes);
}

export function syncDeploymentManifestCircuitHashes(manifest) {
  const deploymentPaths = [
    join(ROOT, "deployments", "v1", "testnet.json"),
    join(ROOT, "deployments", "v1", "mainnet.json"),
  ];

  for (const depPath of deploymentPaths) {
    if (!existsSync(depPath)) continue;
    const dep = JSON.parse(readFileSync(depPath, "utf8"));
    dep.artifacts ??= {};
    dep.artifacts.scanner ??= {};
    dep.artifacts.circuits ??= {};

    dep.artifacts.scanner.wasmHash =
      manifest.scanner?.files?.cryptography_bg?.wasm?.sha256 ??
      manifest.scanner?.files?.["cryptography_bg.wasm"]?.sha256 ??
      null;

    for (const version of ["v1", "v2"]) {
      const circuit = manifest.circuits?.[version];
      if (!circuit) continue;
      dep.artifacts.circuits[version] ??= {};
      dep.artifacts.circuits[version].witnessWasmHash =
        circuit.frontend?.witnessWasm?.sha256 ?? null;
      dep.artifacts.circuits[version].zkeyHash = circuit.frontend?.zkey?.sha256 ?? null;
      dep.artifacts.circuits[version].r1csHash = circuit.build?.r1cs?.sha256 ?? null;
      dep.artifacts.circuits[version].verificationKeyHash =
        circuit.build?.verificationKey?.sha256 ??
        circuit.contractVk?.referenceVerificationKey?.sha256 ??
        null;
      dep.artifacts.circuits[version].contractVkHash =
        circuit.contractVk?.embeddedVkHash ?? null;
      dep.artifacts.circuits[version].zkeyHashBinding =
        circuit.contractVk?.zkeyHash ?? circuit.frontend?.zkey?.sha256 ?? null;
    }

    writeFileSync(depPath, `${JSON.stringify(dep, null, 2)}\n`);
  }
}
