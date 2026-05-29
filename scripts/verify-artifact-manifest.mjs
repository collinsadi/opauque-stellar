#!/usr/bin/env node
/**
 * Verify local artifacts against artifacts/manifest.json.
 *
 * Usage:
 *   node scripts/verify-artifact-manifest.mjs
 *   node scripts/verify-artifact-manifest.mjs --scanner
 *   node scripts/verify-artifact-manifest.mjs --circuits --strict
 *   node scripts/verify-artifact-manifest.mjs --vk-binding
 */

import { existsSync } from "node:fs";
import {
  loadManifest,
  iterArtifactEntries,
  verifyEntry,
  isSetHash,
  hashEmbeddedContractVk,
  resolveArtifactPath,
  sha256File,
} from "./artifact-manifest-lib.mjs";

function parseArgs(argv) {
  const opts = {
    scanner: false,
    circuits: false,
    vkBinding: false,
    strict: false,
    all: true,
  };
  mainLoop: for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case "--scanner":
        opts.scanner = true;
        opts.all = false;
        break;
      case "--circuits":
        opts.circuits = true;
        opts.all = false;
        break;
      case "--vk-binding":
        opts.vkBinding = true;
        opts.all = false;
        break;
      case "--strict":
        opts.strict = true;
        break;
      default:
        break mainLoop;
    }
  }
  if (opts.all) {
    opts.scanner = true;
    opts.circuits = true;
    opts.vkBinding = true;
  }
  return opts;
}

function shouldCheckEntry(group, opts) {
  if (group.startsWith("scanner")) return opts.scanner;
  if (group.startsWith("circuits")) return opts.circuits;
  return true;
}

function verifyVkBinding(manifest) {
  const errors = [];
  for (const version of ["v1", "v2"]) {
    const circuit = manifest.circuits?.[version];
    if (!circuit?.contractVk) continue;

    const { groth16Verifier, embeddedVkHash, zkeyHash } = circuit.contractVk;
    const libPath = resolveArtifactPath(groth16Verifier);
    if (!existsSync(libPath)) {
      errors.push(`circuits.${version}: missing ${groth16Verifier}`);
      continue;
    }

    let actualEmbedded;
    try {
      actualEmbedded = hashEmbeddedContractVk(groth16Verifier, { v2: version === "v2" });
    } catch (err) {
      errors.push(`circuits.${version}: failed to hash embedded VK: ${err.message}`);
      continue;
    }

    if (isSetHash(embeddedVkHash)) {
      if (embeddedVkHash !== actualEmbedded) {
        errors.push(
          `circuits.${version}.contractVk.embeddedVkHash mismatch: manifest=${embeddedVkHash} lib.rs=${actualEmbedded}`,
        );
      }
    }

    const vkPath =
      circuit.build?.verificationKey?.path ??
      circuit.contractVk?.referenceVerificationKey?.path;
    const vkHashExpected =
      circuit.build?.verificationKey?.sha256 ??
      circuit.contractVk?.referenceVerificationKey?.sha256;

    if (vkPath && isSetHash(vkHashExpected)) {
      const vkFull = resolveArtifactPath(vkPath);
      if (existsSync(vkFull)) {
        const vkActual = sha256File(vkFull);
        if (vkActual !== vkHashExpected) {
          errors.push(
            `circuits.${version}.verificationKey hash mismatch: manifest=${vkHashExpected} file=${vkActual}`,
          );
        }
      }
    }

    const zkeyExpected = circuit.frontend?.zkey?.sha256;
    if (isSetHash(zkeyHash) && isSetHash(zkeyExpected) && zkeyHash !== zkeyExpected) {
      errors.push(
        `circuits.${version}: contractVk.zkeyHash (${zkeyHash}) != frontend zkey hash (${zkeyExpected})`,
      );
    }
  }
  return errors;
}

function main() {
  const opts = parseArgs(process.argv);
  const manifest = loadManifest();
  const errors = [];

  for (const entry of iterArtifactEntries(manifest)) {
    if (!shouldCheckEntry(entry.group, opts)) continue;
    const label = `${entry.group}.${entry.name}`;
    const fullPath = resolveArtifactPath(entry.path);
    const filePresent = existsSync(fullPath);
    const { errors: entryErrors, skipped, missing } = verifyEntry(entry, {
      strict: opts.strict || filePresent,
      label,
    });
    errors.push(...entryErrors);
    if (skipped && !opts.strict) {
      console.log(`SKIP: ${label} (hash not pinned)`);
    } else if (missing && !opts.strict) {
      console.log(`MISSING: ${label} (fetch/build required)`);
    } else if (entryErrors.length === 0 && !skipped) {
      console.log(`OK: ${label}`);
    }
  }

  if (opts.vkBinding) {
    errors.push(...verifyVkBinding(manifest));
  }

  if (errors.length > 0) {
    console.error("\nArtifact verification failed:");
    for (const err of errors) console.error(`  - ${err}`);
    process.exit(1);
  }

  console.log("\nOK: artifact manifest verified");
}

main();
