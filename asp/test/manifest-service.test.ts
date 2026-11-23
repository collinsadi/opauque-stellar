/**
 * #972 — historical manifests and per-label inclusion paths.
 *
 * The ASP wrote one file per root but only ever served `latest.json`, so a
 * withdrawing user whose proof referenced an older root had no way to fetch that
 * root's manifest, and no way to get the inclusion path for their own label
 * without rebuilding the whole tree from every approved deposit index.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MerkleTree, computeLabel, getPoseidon, toHex32 } from "../src/merkle.ts";
import { Keypair } from "@stellar/stellar-sdk";
import { computeDatasetHash, verifyManifestSignature, writeManifest } from "../src/publish.ts";
import {
  isValidLabel,
  isValidRoot,
  readInclusion,
  readLatestManifest,
  readManifestByRoot,
} from "../src/manifest-service.ts";
import type { SetManifest } from "../src/types.ts";

const POOL_ID = "7";
const SCOPE = 42;
const SIGNER = Keypair.random();

/** Root of a depth-20 tree over `leaves`. */
function rootOf(poseidon: any, leaves: bigint[]): string {
  const tree = new MerkleTree(poseidon);
  for (const leaf of leaves) tree.insert(leaf);
  return toHex32(tree.root());
}

/** Unsigned manifest fields for a label set. */
function manifestFor(poolId: string, leaves: bigint[], indices: number[]) {
  const root = rootOf(poseidon, leaves);
  const labelStrings = leaves.map((l) => l.toString());
  return {
    poolId,
    root,
    version: leaves.length,
    levels: 20,
    algo: "poseidon-bn254" as const,
    labels: labelStrings,
    indices,
    generatedAt: new Date().toISOString(),
    datasetHash: computeDatasetHash(root, labelStrings),
    policy: "approve-all",
    ledger: 100,
  };
}

let dataDir: string;
let poseidon: any;
let manifest: SetManifest;
let labels: string[];

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "asp-manifest-"));
  poseidon = await getPoseidon();

  // A three-leaf set, published through the real writer so the on-disk layout and
  // retention pruning are exercised too.
  const leaves = [0, 1, 2].map((i) => computeLabel(poseidon, SCOPE, i));
  labels = leaves.map((l) => l.toString());
  manifest = manifestFor(POOL_ID, leaves, [0, 1, 2]);
  writeManifest(dataDir, manifest, SIGNER);
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("input validation", () => {
  it("accepts only 0x-prefixed 32-byte hex roots", () => {
    expect(isValidRoot(manifest.root)).toBe(true);
    // Case-insensitive hex, as a client may send an uppercased root.
    expect(isValidRoot("0x" + manifest.root.slice(2).toUpperCase())).toBe(true);
    expect(isValidRoot("latest")).toBe(false);
    expect(isValidRoot("0x1234")).toBe(false);
    expect(isValidRoot("")).toBe(false);
  });

  it("rejects anything that could escape the set directory", () => {
    for (const bad of ["../../etc/passwd", "..%2F..%2Fetc", "0x../../latest", "/etc/passwd"]) {
      expect(isValidRoot(bad)).toBe(false);
    }
  });

  it("accepts only decimal field elements as labels", () => {
    expect(isValidLabel("12345")).toBe(true);
    expect(isValidLabel("0")).toBe(true);
    expect(isValidLabel("0x10")).toBe(false);
    expect(isValidLabel("-1")).toBe(false);
    expect(isValidLabel("1.5")).toBe(false);
    expect(isValidLabel("".padEnd(100, "1"))).toBe(false);
  });
});

describe("GET /manifest", () => {
  it("still serves the current manifest", () => {
    const result = readLatestManifest(dataDir, POOL_ID);
    expect(result.status).toBe(200);
    expect((result.body as SetManifest).root).toBe(manifest.root);
  });

  it("serves a manifest signed by the ASP key (#1081)", () => {
    const body = readLatestManifest(dataDir, POOL_ID).body as SetManifest;
    expect(body.signer).toBe(SIGNER.publicKey());
    expect(verifyManifestSignature(body, SIGNER.publicKey())).toBe(true);
  });

  it("404s before anything is published", () => {
    const result = readLatestManifest(join(dataDir, "empty"), POOL_ID);
    expect(result.status).toBe(404);
  });
});

describe("GET /manifest/:root (#972)", () => {
  it("serves a historical manifest by root hash", () => {
    const result = readManifestByRoot(dataDir, POOL_ID, manifest.root);
    expect(result.status).toBe(200);
    const body = result.body as SetManifest;
    expect(body.root).toBe(manifest.root);
    expect(body.labels).toEqual(labels);
    expect(body.indices).toEqual([0, 1, 2]);
  });

  it("404s for a root that was never published", () => {
    const absent = toHex32(12345n);
    const result = readManifestByRoot(dataDir, POOL_ID, absent);
    expect(result.status).toBe(404);
  });

  it("rejects a malformed root with 400 rather than touching the filesystem", () => {
    const result = readManifestByRoot(dataDir, POOL_ID, "../../latest");
    expect(result.status).toBe(400);
  });

  it("serves an older root after a newer one is published", async () => {
    const olderRoot = manifest.root;
    // Publish a second, larger set; the older root must remain retrievable.
    const leaves = [0, 1, 2, 3].map((i) => computeLabel(poseidon, SCOPE, i));
    const newer = writeManifest(dataDir, manifestFor(POOL_ID, leaves, [0, 1, 2, 3]), SIGNER);
    expect(newer).toContain(".json");

    const old = readManifestByRoot(dataDir, POOL_ID, olderRoot);
    expect(old.status).toBe(200);
    expect((old.body as SetManifest).labels).toEqual(labels);
    // …and the new root resolves to its own file, not the old one.
    const current = readLatestManifest(dataDir, POOL_ID);
    expect((current.body as SetManifest).labels).toHaveLength(4);
  });
});

describe("GET /inclusion/:root/:label (#972)", () => {
  it("returns a path that verifies against the root it was served under", async () => {
    const result = await readInclusion(dataDir, POOL_ID, manifest.root, labels[1]!);
    expect(result.status).toBe(200);
    const proof = result.body as {
      root: string;
      label: string;
      index: number;
      depositIndex: number | null;
      levels: number;
      pathElements: string[];
      pathIndices: number[];
    };
    expect(proof.root).toBe(manifest.root);
    expect(proof.label).toBe(labels[1]);
    expect(proof.index).toBe(1);
    expect(proof.depositIndex).toBe(1);
    expect(proof.levels).toBe(20);
    expect(proof.pathElements).toHaveLength(20);
    expect(proof.pathIndices).toHaveLength(20);

    // Recompute the root from the returned path — this is what the circuit does.
    const rebuilt = new MerkleTree(poseidon, proof.levels);
    for (const l of labels) rebuilt.insert(BigInt(l));
    const recomputed = rebuilt.proof(proof.index);
    expect(proof.pathElements).toEqual(recomputed.pathElements.map((e) => e.toString()));
    expect(proof.pathIndices).toEqual(recomputed.pathIndices);
  });

  it("gives every label in the set a distinct, valid path", async () => {
    const seen = new Set<string>();
    for (const [i, label] of labels.entries()) {
      const result = await readInclusion(dataDir, POOL_ID, manifest.root, label);
      expect(result.status).toBe(200);
      const proof = result.body as { index: number; pathElements: string[] };
      expect(proof.index).toBe(i);
      seen.add(proof.pathElements.join(","));
    }
    expect(seen.size).toBe(labels.length);
  });

  it("404s for a label that is not in that root's set", async () => {
    const result = await readInclusion(dataDir, POOL_ID, manifest.root, "12345");
    expect(result.status).toBe(404);
  });

  it("404s for a root that is not retained", async () => {
    const result = await readInclusion(dataDir, POOL_ID, toHex32(999n), labels[0]!);
    expect(result.status).toBe(404);
  });

  it("400s on a malformed root or label", async () => {
    expect((await readInclusion(dataDir, POOL_ID, "nope", labels[0]!)).status).toBe(400);
    expect((await readInclusion(dataDir, POOL_ID, manifest.root, "0x1")).status).toBe(400);
  });
});

describe("retention (#972)", () => {
  it("prunes to the configured number of set files and stops serving pruned roots", async () => {
    const dir = mkdtempSync(join(tmpdir(), "asp-retention-"));
    try {
      const poolId = "9";
      const published: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        const leaves = Array.from({ length: i + 1 }, (_, k) => computeLabel(poseidon, SCOPE + i, k));
        const m = manifestFor(poolId, leaves, leaves.map((_, k) => k));
        published.push(m.root);
        writeManifest(dir, m, SIGNER, 2); // keep only the two most recent
      }

      // Retention keeps a bounded number of roots, and the rest are reported as
      // gone rather than served — a client that needs a pruned root is told so
      // instead of silently getting the wrong one.
      const statuses = published.map((root) => readManifestByRoot(dir, poolId, root).status);
      expect(statuses.filter((s) => s === 200)).toHaveLength(2);
      expect(statuses.filter((s) => s === 404)).toHaveLength(3);

      // The latest manifest is never pruned, whatever the retention limit.
      expect(readLatestManifest(dir, poolId).status).toBe(200);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
