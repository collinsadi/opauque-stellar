#!/usr/bin/env node
/**
 * Download pinned circuit artifacts from GitHub release assets into frontend/public/circuits/.
 * Skips files that already match the manifest hash.
 *
 * Usage:
 *   node scripts/fetch-circuit-artifacts.mjs
 *   node scripts/fetch-circuit-artifacts.mjs --force
 *   CIRCUIT_ARTIFACTS_BASE_URL=https://... node scripts/fetch-circuit-artifacts.mjs
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  loadManifest,
  resolveArtifactPath,
  sha256File,
  isSetHash,
} from "./artifact-manifest-lib.mjs";

function parseArgs(argv) {
  return { force: argv.includes("--force") };
}

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`GET ${url} failed: ${res.status} ${res.statusText}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

function ensureDirFor(filePath) {
  mkdirSync(dirname(filePath), { recursive: true });
}

async function fetchArtifact({ url, destPath, expectedHash, force }) {
  const fullDest = resolveArtifactPath(destPath);
  ensureDirFor(fullDest);

  if (!force && existsSync(fullDest) && isSetHash(expectedHash)) {
    const actual = sha256File(fullDest);
    if (actual === expectedHash) {
      console.log(`OK (cached): ${destPath}`);
      return;
    }
    console.log(`Re-fetch ${destPath}: hash mismatch`);
  }

  console.log(`Fetching ${url} -> ${destPath}`);
  const data = await download(url);
  writeFileSync(fullDest, data);

  if (isSetHash(expectedHash)) {
    const actual = sha256File(fullDest);
    if (actual !== expectedHash) {
      throw new Error(`${destPath}: downloaded hash ${actual} != manifest ${expectedHash}`);
    }
  }

  console.log(`Saved ${destPath}${isSetHash(expectedHash) ? " (hash verified)" : ""}`);
}

async function main() {
  const opts = parseArgs(process.argv);
  const manifest = loadManifest();
  const base =
    process.env.CIRCUIT_ARTIFACTS_BASE_URL?.replace(/\/$/, "") ??
    manifest.releaseAssets.baseUrl;

  const { files } = manifest.releaseAssets;
  const jobs = [
    {
      url: `${base}/${files.v1_zkey}`,
      destPath: manifest.circuits.v1.frontend.zkey.path,
      expectedHash: manifest.circuits.v1.frontend.zkey.sha256,
    },
    {
      url: `${base}/${files.v1_witness_wasm}`,
      destPath: manifest.circuits.v1.frontend.witnessWasm.path,
      expectedHash: manifest.circuits.v1.frontend.witnessWasm.sha256,
    },
    {
      url: `${base}/${files.v2_zkey}`,
      destPath: manifest.circuits.v2.frontend.zkey.path,
      expectedHash: manifest.circuits.v2.frontend.zkey.sha256,
    },
    {
      url: `${base}/${files.v2_witness_wasm}`,
      destPath: manifest.circuits.v2.frontend.witnessWasm.path,
      expectedHash: manifest.circuits.v2.frontend.witnessWasm.sha256,
    },
  ];

  const missingHashes = jobs.filter((j) => !isSetHash(j.expectedHash));
  if (missingHashes.length > 0) {
    console.warn(
      "Some circuit hashes are not pinned yet; downloads will not be verified:",
      missingHashes.map((j) => j.destPath).join(", "),
    );
  }

  for (const job of jobs) {
    try {
      await fetchArtifact({ ...job, force: opts.force });
    } catch (err) {
      if (err.message.includes("404")) {
        console.warn(`Skip ${job.destPath}: release asset not found (${err.message})`);
        continue;
      }
      throw err;
    }
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
