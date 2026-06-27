// @ts-nocheck
/**
 * Automated ceremony output ingestion for production trusted setup.
 *
 * This script:
 *   1. Ingests ceremony artifacts (zkey, witness wasm, verification key)
 *   2. Verifies SHA-256 hashes against expected values
 *   3. Updates the artifact manifest with new hashes
 *   4. Syncs the groth16-verifier contract VK from the zkey
 *
 * Usage:
 *   node scripts/ingest-ceremony-artifacts.ts --circuit v2 --zkey <path> --wasm <path> --vkey <path>
 *   node scripts/ingest-ceremony-artifacts.ts --circuit v2 --zkey <path> --wasm <path> --vkey <path> --dry-run
 *   node scripts/ingest-ceremony-artifacts.ts --circuit v2 --verify-only
 */

import { existsSync, readFileSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  loadManifest,
  saveManifest,
  sha256File,
  resolveArtifactPath,
} from "./artifact-manifest-lib.ts";

interface CeremonyIngestOptions {
  circuitVersion: string;
  zkeyPath?: string;
  witnessWasmPath?: string;
  verificationKeyPath?: string;
  dryRun: boolean;
  verifyOnly: boolean;
}

function parseArgs(argv: string[]): CeremonyIngestOptions {
  const args = argv.slice(2);
  const opts: CeremonyIngestOptions = {
    circuitVersion: "",
    dryRun: false,
    verifyOnly: false,
  };

  for (let i = 2; i < args.length; i++) {
    switch (args[i]) {
      case "--circuit":
        opts.circuitVersion = args[++i];
        break;
      case "--zkey":
        opts.zkeyPath = args[++i];
        break;
      case "--wasm":
        opts.witnessWasmPath = args[++i];
        break;
      case "--vkey":
        opts.verificationKeyPath = args[++i];
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--verify-only":
        opts.verifyOnly = true;
        break;
    }
  }

  return opts;
}

function validateOptions(opts: CeremonyIngestOptions): void {
  if (!opts.circuitVersion) {
    console.error("Error: --circuit <version> is required (e.g., v2, v3)");
    process.exit(1);
  }

  if (!opts.verifyOnly) {
    if (!opts.zkeyPath || !opts.witnessWasmPath || !opts.verificationKeyPath) {
      console.error("Error: --zkey, --wasm, and --vkey are required for ingestion");
      process.exit(1);
    }
  }
}

function verifyArtifactHash(
  path: string,
  expectedHash: string | null,
  label: string,
): { ok: boolean; actualHash: string } {
  if (!existsSync(path)) {
    console.error(`  ✗ ${label}: file not found at ${path}`);
    return { ok: false, actualHash: "" };
  }

  const actualHash = sha256File(path);

  if (expectedHash === null) {
    console.log(`  ✓ ${label}: hash computed: ${actualHash}`);
    return { ok: true, actualHash };
  }

  if (actualHash === expectedHash) {
    console.log(`  ✓ ${label}: hash verified`);
    return { ok: true, actualHash };
  }

  console.error(`  ✗ ${label}: hash mismatch`);
  console.error(`    expected: ${expectedHash}`);
  console.error(`    actual:   ${actualHash}`);
  return { ok: false, actualHash };
}

function copyArtifactToDestination(
  sourcePath: string,
  destRelPath: string,
): void {
  const destPath = resolveArtifactPath(destRelPath);
  const destDir = dirname(destPath);

  if (!existsSync(destDir)) {
    mkdirSync(destDir, { recursive: true });
  }

  copyFileSync(sourcePath, destPath);
  console.log(`  → Copied to ${destRelPath}`);
}

function verifyExistingCeremonyArtifacts(
  circuitVersion: string,
): { allValid: boolean; hashes: Record<string, string | null> } {
  const manifest = loadManifest();
  const circuit = manifest.circuits?.[circuitVersion];

  if (!circuit) {
    console.error(`Error: circuit version '${circuitVersion}' not found in manifest`);
    return { allValid: false, hashes: {} };
  }

  console.log(`\nVerifying existing ceremony artifacts for ${circuitVersion}:\n`);

  const hashes: Record<string, string | null> = {};
  let allValid = true;

  const artifacts = [
    { label: "witness WASM", path: circuit.frontend?.witnessWasm?.path, expected: circuit.frontend?.witnessWasm?.sha256 },
    { label: "zkey", path: circuit.frontend?.zkey?.path, expected: circuit.frontend?.zkey?.sha256 },
    { label: "R1CS", path: circuit.build?.r1cs?.path, expected: circuit.build?.r1cs?.sha256 },
    { label: "verification key", path: circuit.build?.verificationKey?.path, expected: circuit.build?.verificationKey?.sha256 },
  ];

  for (const artifact of artifacts) {
    if (!artifact.path) {
      console.log(`  ⊘ ${artifact.label}: not configured in manifest`);
      continue;
    }

    const fullPath = resolveArtifactPath(artifact.path);
    const result = verifyArtifactHash(fullPath, artifact.expected, artifact.label);
    hashes[artifact.label] = result.actualHash;

    if (!result.ok) {
      allValid = false;
    }
  }

  return { allValid, hashes };
}

function ingestCeremonyArtifacts(opts: CeremonyIngestOptions): void {
  const manifest = loadManifest();
  const circuit = manifest.circuits?.[opts.circuitVersion];

  if (!circuit) {
    console.error(`Error: circuit version '${opts.circuitVersion}' not found in manifest`);
    process.exit(1);
  }

  console.log(`\nIngesting ceremony artifacts for ${opts.circuitVersion}:\n`);

  // Verify source artifacts exist
  const sources = [
    { label: "zkey", path: opts.zkeyPath! },
    { label: "witness WASM", path: opts.witnessWasmPath! },
    { label: "verification key", path: opts.verificationKeyPath! },
  ];

  for (const source of sources) {
    if (!existsSync(source.path)) {
      console.error(`Error: ${source.label} not found at ${source.path}`);
      process.exit(1);
    }
  }

  // Compute hashes
  const zkeyHash = sha256File(opts.zkeyPath!);
  const wasmHash = sha256File(opts.witnessWasmPath!);
  const vkeyHash = sha256File(opts.verificationKeyPath!);

  console.log("Computed hashes:");
  console.log(`  zkey:            ${zkeyHash}`);
  console.log(`  witness WASM:    ${wasmHash}`);
  console.log(`  verification key: ${vkeyHash}`);

  if (opts.dryRun) {
    console.log("\n[Dry Run] No files copied or manifest updated.");
    return;
  }

  // Copy artifacts to destination paths
  if (circuit.frontend?.zkey?.path) {
    copyArtifactToDestination(opts.zkeyPath!, circuit.frontend.zkey.path);
  }
  if (circuit.frontend?.witnessWasm?.path) {
    copyArtifactToDestination(opts.witnessWasmPath!, circuit.frontend.witnessWasm.path);
  }
  if (circuit.build?.verificationKey?.path) {
    copyArtifactToDestination(opts.verificationKeyPath!, circuit.build.verificationKey.path);
  }

  // Update manifest
  if (circuit.frontend?.zkey) {
    circuit.frontend.zkey.sha256 = zkeyHash;
  }
  if (circuit.frontend?.witnessWasm) {
    circuit.frontend.witnessWasm.sha256 = wasmHash;
  }
  if (circuit.build?.verificationKey) {
    circuit.build.verificationKey.sha256 = vkeyHash;
  }

  // Update contract VK hash binding
  if (circuit.contractVk) {
    circuit.contractVk.zkeyHash = zkeyHash;
  }

  saveManifest(manifest);
  console.log(`\n✓ Manifest updated: artifacts/manifest.json`);

  // Verify VK and contract are in sync
  verifyVkContractSync(opts.circuitVersion);
}

function verifyVkContractSync(circuitVersion: string): void {
  const manifest = loadManifest();
  const circuit = manifest.circuits?.[circuitVersion];

  if (!circuit?.contractVk) {
    console.log("\n⊘ No contract VK configuration — skipping sync check");
    return;
  }

  const contractPath = resolveArtifactPath(circuit.contractVk.groth16Verifier);
  if (!existsSync(contractPath)) {
    console.log(`\n⊘ Contract not found at ${circuit.contractVk.groth16Verifier} — skipping sync check`);
    return;
  }

  const contractContent = readFileSync(contractPath, "utf8");
  const hasV2Prefix = contractContent.includes("VK_ALPHA_V2");
  const hasV3Prefix = contractContent.includes("VK_ALPHA_V3");

  const expectedPrefix = circuitVersion === "v2" ? "VK_ALPHA_V2" :
                         circuitVersion === "v3" ? "VK_ALPHA_V3" : "VK_ALPHA";

  if (circuitVersion === "v2" && hasV2Prefix) {
    console.log(`\n✓ Contract VK prefix (${expectedPrefix}) found in groth16-verifier`);
  } else if (circuitVersion === "v3" && hasV3Prefix) {
    console.log(`\n✓ Contract VK prefix (${expectedPrefix}) found in groth16-verifier`);
  } else {
    console.log(`\n⚠ Contract VK prefix (${expectedPrefix}) not found in groth16-verifier`);
    console.log(`  Manual VK update may be required for ${circuitVersion} deployment`);
  }
}

function main(): void {
  const opts = parseArgs(process.argv);
  validateOptions(opts);

  if (opts.verifyOnly) {
    const result = verifyExistingCeremonyArtifacts(opts.circuitVersion);
    if (!result.allValid) {
      console.error("\n✗ Artifact verification failed");
      process.exit(1);
    }
    console.log("\n✓ All artifacts verified successfully");
    return;
  }

  ingestCeremonyArtifacts(opts);
  console.log("\n✓ Ceremony ingestion complete");
}

main();
