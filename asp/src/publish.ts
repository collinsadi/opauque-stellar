/**
 * Manifest publishing. The set manifest is self-authenticating — anyone can recompute the
 * Merkle root from `labels` and check it equals the on-chain `aspRoot` — so IPFS pinning
 * is optional and the file store is purely a convenience/cache.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readdirSync, unlinkSync, renameSync, statSync, openSync, fsyncSync, closeSync } from "node:fs";
import { join } from "node:path";
import type { SetManifest } from "./types.ts";

/**
 * Deterministic 32-byte dataset hash binding a published root to its exact leaf set.
 * Stored on-chain alongside the root (the contract treats it as opaque). SHA256 covers
 * BE32(count), the canonical root bytes, and canonical 32-byte leaf values.
 */
export function computeDatasetHash(root: string, labels: string[]): string {
  const h = createHash("sha256");
  const count = Buffer.alloc(4);
  count.writeUInt32BE(labels.length >>> 0, 0);
  h.update(count);
  h.update(Buffer.from(root.replace(/^0x/, ""), "hex"));
  for (const label of labels) {
    let value = BigInt(label);
    const bytes = Buffer.alloc(32);
    for (let i = 31; i >= 0; i--) { bytes[i] = Number(value & 255n); value >>= 8n; }
    h.update(bytes);
  }
  return "0x" + h.digest("hex");
}

/**
 * Compute a signature over the manifest for authentication (issue #1011).
 * The signature covers poolId, root, datasetHash, policy, and ledger.
 */
export function signManifest(manifest: SetManifest, signingKey: string): string {
  const h = createHash("sha256");
  h.update(manifest.poolId);
  h.update(manifest.root);
  h.update(manifest.datasetHash);
  h.update(manifest.policy ?? "");
  h.update(String(manifest.ledger ?? ""));
  h.update(signingKey);
  return "0x" + h.digest("hex");
}

/**
 * Verify a manifest signature against the signing key (issue #1011).
 */
export function verifyManifestSignature(
  manifest: SetManifest,
  signature: string,
  signingKey: string,
): boolean {
  const expected = signManifest(manifest, signingKey);
  return expected === signature;
}

/**
 * Default retention policy: keep the most recent N set files per pool (issue #1011).
 * Older roots are pruned to prevent unbounded disk growth.
 */
// Must cover the contract's MAX_ROOT_HISTORY (100); retaining fewer manifests
// makes still-valid on-chain roots unusable by withdrawers.
const DEFAULT_MAX_SETS_PER_POOL = 100;

/**
 * Write `data/sets/<poolId>/<root>.json` and `latest.json` atomically (issue #1011).
 *
 * Uses temp-file-plus-rename to prevent corruption if the process crashes
 * mid-write. Includes dataset hash, policy, ledger, and signature in the
 * manifest for consumer authentication.
 */
export function writeManifest(
  dataDir: string,
  manifest: SetManifest,
  signingKey?: string,
  maxSetsPerPool: number = DEFAULT_MAX_SETS_PER_POOL,
): string {
  const dir = join(dataDir, "sets", manifest.poolId);
  mkdirSync(dir, { recursive: true });

  // Add signature if signing key provided (issue #1011)
  const signedManifest = signingKey
    ? { ...manifest, signature: signManifest(manifest, signingKey) }
    : manifest;

  const manifestJson = `${JSON.stringify(signedManifest, null, 2)}\n`;

  // Atomic write: write to temp file then rename (issue #1011)
  const rootPath = join(dir, `${manifest.root}.json`);
  const tmpPath = `${rootPath}.tmp.${Date.now()}`;
  writeFileSync(tmpPath, manifestJson);
  const rootFd = openSync(tmpPath, "r");
  try { fsyncSync(rootFd); } finally { closeSync(rootFd); }
  renameSync(tmpPath, rootPath);

  // Atomic write for latest.json
  const latestPath = join(dir, "latest.json");
  const latestTmpPath = `${latestPath}.tmp.${Date.now()}`;
  writeFileSync(latestTmpPath, manifestJson);
  const latestFd = openSync(latestTmpPath, "r");
  try { fsyncSync(latestFd); } finally { closeSync(latestFd); }
  renameSync(latestTmpPath, latestPath);

  // Prune old sets (issue #1011)
  pruneOldSets(dir, maxSetsPerPool);

  return rootPath;
}

/**
 * Prune old set files, keeping only the most recent N (issue #1011).
 * Ordered by modification time (newest first) so retention evicts the oldest
 * roots. Filenames are root hashes, so sorting by name would evict an arbitrary
 * set — including a root a withdrawing user is still proving against (#972).
 */
function pruneOldSets(dir: string, maxKeep: number): void {
  try {
    const candidates = readdirSync(dir)
      .filter((f) => f.endsWith(".json") && f !== "latest.json" && !f.endsWith(".tmp"))
      .map((f) => {
        let mtimeMs = 0;
        try {
          mtimeMs = statSync(join(dir, f)).mtimeMs;
        } catch {
          // Unreadable stat: fall back to 0 so it sorts last and is pruned first.
        }
        return { file: f, mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first

    if (candidates.length > maxKeep) {
      for (const { file } of candidates.slice(maxKeep)) {
        try {
          unlinkSync(join(dir, file));
        } catch {
          // Best-effort pruning; ignore errors on individual files
        }
      }
    }
  } catch {
    // If directory doesn't exist or can't be read, skip pruning
  }
}
