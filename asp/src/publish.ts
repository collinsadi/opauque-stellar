/**
 * Manifest publishing. The set manifest is self-authenticating — anyone can recompute the
 * Merkle root from `labels` and check it equals the on-chain `aspRoot` — so IPFS pinning
 * is optional and the file store is purely a convenience/cache.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readdirSync, unlinkSync, renameSync, statSync, openSync, fsyncSync, closeSync } from "node:fs";
import { join } from "node:path";
import { Keypair } from "@stellar/stellar-sdk";
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

/** Domain separator for manifest signatures; bump the version on any encoding change. */
export const MANIFEST_SIGNATURE_DOMAIN = "opaque-asp-manifest/v1";

/**
 * Anything that can produce an Ed25519 signature and name its Stellar public key.
 * A Stellar `Keypair` satisfies this directly.
 */
export interface ManifestSigner {
  publicKey(): string;
  sign(data: Buffer): Buffer;
}

/** A manifest before it is signed. */
export type UnsignedSetManifest = Omit<SetManifest, "signer" | "signature">;

function lengthPrefixed(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(bytes.length >>> 0, 0);
  return Buffer.concat([len, bytes]);
}

/** sha256(BE32(count) || BE32(index)...) — commits to the deposit index of every label. */
export function computeIndicesHash(indices: number[]): string {
  const buf = Buffer.alloc(4 + 4 * indices.length);
  buf.writeUInt32BE(indices.length >>> 0, 0);
  indices.forEach((index, i) => buf.writeUInt32BE(index >>> 0, 4 + 4 * i));
  return "0x" + createHash("sha256").update(buf).digest("hex");
}

/**
 * Canonical, delimited byte encoding of a manifest's signed fields (#1081).
 *
 * Every field is a UTF-8 string prefixed with its BE32 byte length, in a fixed
 * order, after a versioned domain separator — so no two distinct manifests can
 * encode to the same bytes. Labels are bound through `datasetHash` (which a
 * verifier recomputes from `root` + `labels`) and deposit indices through
 * {@link computeIndicesHash}, keeping the signed message small for large sets.
 *
 * Field order: domain, poolId, root, version, levels, algo, datasetHash,
 * policy, ledger, generatedAt, labelCount, indicesHash. Hex values are lowercase.
 */
export function canonicalManifestBytes(manifest: UnsignedSetManifest): Buffer {
  const fields = [
    MANIFEST_SIGNATURE_DOMAIN,
    manifest.poolId,
    manifest.root.toLowerCase(),
    String(manifest.version),
    String(manifest.levels),
    manifest.algo,
    manifest.datasetHash.toLowerCase(),
    manifest.policy,
    String(manifest.ledger),
    manifest.generatedAt,
    String(manifest.labels.length),
    computeIndicesHash(manifest.indices),
  ];
  return Buffer.concat(fields.map(lengthPrefixed));
}

/**
 * Sign a manifest with the ASP's Ed25519 key (#1081). Returns the manifest with
 * `signer` (the Stellar G-address of the key) and `signature` (hex, 64 bytes).
 */
export function signManifest(manifest: UnsignedSetManifest, signer: ManifestSigner): SetManifest {
  const { signer: _s, signature: _sig, ...unsigned } = manifest as SetManifest;
  const signature = signer.sign(canonicalManifestBytes(unsigned)).toString("hex");
  return { ...unsigned, signer: signer.publicKey(), signature };
}

/**
 * Verify a manifest against the ASP's published public key (Stellar G-address).
 *
 * Checks that the manifest names that key as its signer, that `datasetHash`
 * matches its own `root` + `labels`, and that the Ed25519 signature covers the
 * canonical encoding. Needs only the public key.
 */
export function verifyManifestSignature(manifest: SetManifest, aspPublicKey: string): boolean {
  if (!manifest.signature || !manifest.signer || manifest.signer !== aspPublicKey) return false;
  if (!/^[0-9a-fA-F]{128}$/.test(manifest.signature)) return false;
  if (!Array.isArray(manifest.labels) || !Array.isArray(manifest.indices)) return false;
  if (manifest.labels.length !== manifest.indices.length) return false;
  let datasetHash: string;
  try {
    datasetHash = computeDatasetHash(manifest.root, manifest.labels);
  } catch {
    return false;
  }
  if (datasetHash !== manifest.datasetHash.toLowerCase()) return false;
  try {
    return Keypair.fromPublicKey(aspPublicKey).verify(
      canonicalManifestBytes(manifest),
      Buffer.from(manifest.signature, "hex"),
    );
  } catch {
    return false;
  }
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
 * mid-write. Every written manifest is signed with the ASP's Ed25519 key
 * (#1081), so consumers can authenticate it with the published public key.
 */
export function writeManifest(
  dataDir: string,
  manifest: UnsignedSetManifest,
  signer: ManifestSigner,
  maxSetsPerPool: number = DEFAULT_MAX_SETS_PER_POOL,
): string {
  if (!signer) throw new Error("writeManifest requires the ASP manifest signing key");
  const dir = join(dataDir, "sets", manifest.poolId);
  mkdirSync(dir, { recursive: true });

  const signedManifest = signManifest(manifest, signer);

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
