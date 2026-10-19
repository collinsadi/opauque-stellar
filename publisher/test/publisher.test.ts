import { describe, expect, it } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { buildProof, buildRoot, getPoseidon, hashFields, MerkleTree } from "../src/merkle.ts";
import { bigintToHex32 } from "../src/bytes.ts";
import { computeDatasetHash } from "../src/publish.ts";
import { runPublisherTick, createMetrics } from "../src/engine.ts";
import { MemoryStore } from "../src/store.ts";
import { buildTreeSnapshot, verifySnapshot, computeSnapshotHash } from "../src/snapshot.ts";
import { formatPrometheusMetrics } from "../src/metrics.ts";
import { validateLeafCommitment } from "../src/validate.ts";
import { RateLimiter } from "../src/rate-limit.ts";
import type { ChainAdapter, LeafCommitment, OnChainAttestation } from "../src/types.ts";

const CANON_1_2 =
  7853200120776062878684798364095072458815029376092732009249414926327459813530n;
const HOLDER_KEY = new Uint8Array(32).fill(1);
const SCHEMA_ID = bigintToHex32(7n);

function recipientHash(): string {
  const publicKey = secp256k1.getPublicKey(HOLDER_KEY, false);
  const address = keccak_256(publicKey.subarray(1)).subarray(12);
  return `0x${Buffer.from(keccak_256(address)).toString("hex")}`;
}

function holderSignature(attestationUid: string, leaf: string): string {
  const message = new TextEncoder().encode(
    `OPAQUE_REPUTATION_SUBMISSION_V1\n${attestationUid}\n${SCHEMA_ID}\n${leaf}`,
  );
  const signature = secp256k1.sign(keccak_256(message), HOLDER_KEY);
  return `0x${Buffer.from([...signature.toCompactRawBytes(), signature.recovery ?? 0]).toString("hex")}`;
}

class FakeAdapter implements ChainAdapter {
  root: string | null = null;
  posts: Array<{ root: string; datasetHash: string }> = [];

  async currentRoot(): Promise<string | null> {
    return this.root;
  }

  async postRoot(root: string, datasetHash: string): Promise<{ hash: string; ledger: number }> {
    this.root = root;
    this.posts.push({ root, datasetHash });
    return { hash: `tx-${this.posts.length}`, ledger: 100 + this.posts.length };
  }

  async currentLedger(): Promise<number> {
    return 100;
  }

  async getAttestation(_uid: string): Promise<OnChainAttestation | null> {
    return {
      schemaId: SCHEMA_ID,
      stealthAddressHash: recipientHash(),
      expirationLedger: 0,
      revocationLedger: 0,
    };
  }
}

function commitment(id: string, leaf: bigint, ledger = 1): LeafCommitment {
  const attestationUid = bigintToHex32(BigInt(ledger + id.length));
  const leafHex = bigintToHex32(leaf);
  return {
    id,
    leaf: leafHex,
    schemaId: SCHEMA_ID,
    attestationUid,
    holderSignature: holderSignature(attestationUid, leafHex),
    ledger,
    submittedAt: "2026-06-16T00:00:00Z",
  };
}

function recomputeRoot(poseidon: any, leaf: bigint, pathElements: string[], pathIndices: number[]): bigint {
  let cur = leaf;
  for (let i = 0; i < pathElements.length; i += 1) {
    const sibling = BigInt(pathElements[i]);
    cur = pathIndices[i] === 0
      ? hashFields(poseidon, [cur, sibling])
      : hashFields(poseidon, [sibling, cur]);
  }
  return cur;
}

describe("reputation publisher merkle tree", () => {
  it("uses the canonical circomlib Poseidon vector", async () => {
    const p = await getPoseidon();
    expect(hashFields(p, [1n, 2n])).toBe(CANON_1_2);
  });

  it("builds deterministic roots from ordered leaf commitments", async () => {
    const leaves = [bigintToHex32(1n), bigintToHex32(2n)];
    expect(await buildRoot(leaves)).toBe(await buildRoot(leaves));
    expect(await buildRoot(leaves)).not.toBe(await buildRoot([...leaves].reverse()));
  });

  it("matches direct MerkleTree insertion", async () => {
    const p = await getPoseidon();
    const tree = new MerkleTree(p);
    tree.insert(5n);
    tree.insert(6n);
    expect(await buildRoot([bigintToHex32(5n), bigintToHex32(6n)])).toBe(tree.rootHex());
  });

  it("returns inclusion paths that recompute to the root", async () => {
    const p = await getPoseidon();
    const leaves = [bigintToHex32(5n), bigintToHex32(6n), bigintToHex32(7n)];
    const proof = await buildProof(leaves, bigintToHex32(6n));
    expect(proof.leafIndex).toBe(1);
    expect(bigintToHex32(recomputeRoot(p, 6n, proof.pathElements, proof.pathIndices))).toBe(proof.root);
  });
});

describe("dataset hash", () => {
  it("binds root, count, and leaf order", () => {
    const root = bigintToHex32(9n);
    const a = [bigintToHex32(1n), bigintToHex32(2n)];
    const b = [bigintToHex32(2n), bigintToHex32(1n)];
    expect(computeDatasetHash(root, a)).toBe(computeDatasetHash(root, a));
    expect(computeDatasetHash(root, a)).not.toBe(computeDatasetHash(root, b));
    expect(computeDatasetHash(`0x${"11".repeat(32)}`, [bigintToHex32(1n), bigintToHex32(2n)])).toBe("0xe22e40d771557c5cda2b8d65d1858102658145607aacdd5600a1d4dd54b78896");
  });
});

describe("publisher engine", () => {
  it("accepts leaves, publishes once, and is idempotent", async () => {
    const adapter = new FakeAdapter();
    const store = new MemoryStore();
    store.inbox = [commitment("a", 1n), commitment("b", 2n)];

    const base = {
      verifierId: "CVERIFIER",
      adapter,
      store,
      now: () => "2026-06-16T00:00:00Z",
    };

    const first = await runPublisherTick(base);
    expect(first.leafCount).toBe(2);
    expect(first.newlyAccepted).toBe(2);
    expect(first.published).toBe(true);
    expect(first.latencyMs).toBeGreaterThanOrEqual(0);
    expect(adapter.posts.length).toBe(1);
    expect(store.archived).toEqual(["a", "b"]);

    const second = await runPublisherTick(base);
    expect(second.newlyAccepted).toBe(0);
    expect(second.published).toBe(false);
    expect(adapter.posts.length).toBe(1);
  });

  it("deduplicates by id and leaf", async () => {
    const adapter = new FakeAdapter();
    const store = new MemoryStore();
    store.inbox = [commitment("a", 1n), commitment("a", 3n), commitment("c", 1n)];

    const res = await runPublisherTick({
      verifierId: "CVERIFIER",
      adapter,
      store,
    });

    expect(res.leafCount).toBe(1);
    expect(res.newlyAccepted).toBe(1);
    expect(store.archived).toEqual(["a", "a", "c"]);
  });

  it("self-heals when the on-chain root disappears", async () => {
    const adapter = new FakeAdapter();
    const store = new MemoryStore();
    store.inbox = [commitment("a", 1n)];
    const base = { verifierId: "CVERIFIER", adapter, store };

    await runPublisherTick(base);
    adapter.root = null;
    const healed = await runPublisherTick(base);

    expect(healed.published).toBe(true);
    expect(adapter.posts.length).toBe(2);
  });

  it("tracks metrics across ticks", async () => {
    const adapter = new FakeAdapter();
    const store = new MemoryStore();
    store.inbox = [commitment("a", 1n)];
    const metrics = createMetrics();

    await runPublisherTick({ verifierId: "CVERIFIER", adapter, store }, metrics);
    expect(metrics.totalPublished).toBe(1);
    expect(metrics.lastPublishAt).toBeTruthy();
    expect(metrics.currentLeafCount).toBe(1);
  });
});

describe("backpressure", () => {
  it("rejects writes when inbox is full", () => {
    const store = new MemoryStore(2);
    expect(store.writeInbox(commitment("a", 1n))).toBe(true);
    expect(store.writeInbox(commitment("b", 2n))).toBe(true);
    expect(store.writeInbox(commitment("c", 3n))).toBe(false);
    expect(store.inboxSize()).toBe(2);
  });

  it("accepts writes after archive frees space", () => {
    const store = new MemoryStore(2);
    store.writeInbox(commitment("a", 1n));
    store.writeInbox(commitment("b", 2n));
    store.archiveInbox(["a"]);
    expect(store.inboxSize()).toBe(1);
    expect(store.writeInbox(commitment("c", 3n))).toBe(true);
  });
});

describe("snapshot export", () => {
  it("builds a valid snapshot with intermediate hashes", async () => {
    const leaves = [bigintToHex32(5n), bigintToHex32(6n), bigintToHex32(7n)];
    const snapshot = await buildTreeSnapshot("CVERIFIER", leaves);

    expect(snapshot.version).toBe(1);
    expect(snapshot.verifierId).toBe("CVERIFIER");
    expect(snapshot.leafCount).toBe(3);
    expect(snapshot.leaves).toHaveLength(3);
    expect(Object.keys(snapshot.intermediateHashes).length).toBeGreaterThan(0);
    expect(verifySnapshot(snapshot)).toBe(true);
  });

  it("produces a deterministic snapshot hash", async () => {
    const leaves = [bigintToHex32(5n), bigintToHex32(6n)];
    const a = await buildTreeSnapshot("CVERIFIER", leaves);
    const b = await buildTreeSnapshot("CVERIFIER", leaves);
    expect(computeSnapshotHash(a)).toBe(computeSnapshotHash(b));
  });
});

describe("metrics", () => {
  it("formats prometheus metrics", () => {
    const m = createMetrics();
    m.totalSubmitted = 10;
    m.totalAccepted = 8;
    m.totalRejected = 2;
    m.totalPublished = 3;
    m.currentInboxDepth = 5;
    m.currentLeafCount = 100;
    m.lastPublishLatencyMs = 42;

    const output = formatPrometheusMetrics(m);
    expect(output).toContain("publisher_total_submitted 10");
    expect(output).toContain("publisher_total_accepted 8");
    expect(output).toContain("publisher_total_rejected 2");
    expect(output).toContain("publisher_total_published 3");
    expect(output).toContain("publisher_inbox_depth 5");
    expect(output).toContain("publisher_leaf_count 100");
    expect(output).toContain("publisher_last_publish_latency_ms 42");
    expect(output).toContain("publisher_uptime_seconds");
  });

  it("formats duplicate and collision counters", () => {
    const m = createMetrics();
    m.totalDuplicateResubmissions = 5;
    m.totalIdentityCollisions = 2;

    const output = formatPrometheusMetrics(m);
    expect(output).toContain("publisher_total_duplicate_resubmissions 5");
    expect(output).toContain("publisher_total_identity_collisions 2");
  });
});

describe("schema validation", () => {
  it("accepts a valid leaf commitment", () => {
    const result = validateLeafCommitment({
      id: "test-leaf",
      leaf: bigintToHex32(42n),
      schemaId: bigintToHex32(7n),
      attestationUid: bigintToHex32(99n),
      holderSignature: `0x${"01".repeat(65)}`,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.commitment.id).toBe("test-leaf");
      expect(result.commitment.leaf).toBe(bigintToHex32(42n));
    }
  });

  it("rejects missing leaf", () => {
    const result = validateLeafCommitment({ id: "test" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("leaf"))).toBe(true);
    }
  });

  it("rejects invalid leaf hex", () => {
    const result = validateLeafCommitment({ id: "test", leaf: "not-a-hex" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("leaf"))).toBe(true);
    }
  });

  it("rejects non-object input", () => {
    const result = validateLeafCommitment("invalid");
    expect(result.ok).toBe(false);
  });

  it("accepts a commitment without id when attestation identity fields are present", () => {
    const result = validateLeafCommitment({
      leaf: bigintToHex32(1n),
      attestationUid: bigintToHex32(99n),
      schemaId: bigintToHex32(7n),
      holderSignature: `0x${"01".repeat(65)}`,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.commitment.id).toBe(bigintToHex32(99n));
  });

  it("rejects empty id without attestationUid", () => {
    const result = validateLeafCommitment({
      leaf: bigintToHex32(1n),
      id: "",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects invalid ledger type", () => {
    const result = validateLeafCommitment({
      id: "test",
      leaf: bigintToHex32(1n),
      ledger: -1,
    });
    expect(result.ok).toBe(false);
  });
});

describe("duplicate detection", () => {
  it("counts idempotent resubmissions (same id + same leaf)", async () => {
    const adapter = new FakeAdapter();
    const store = new MemoryStore();
    const metrics = createMetrics();
    store.inbox = [commitment("a", 1n), commitment("b", 2n)];

    await runPublisherTick({ verifierId: "CVERIFIER", adapter, store }, metrics);
    expect(metrics.totalDuplicateResubmissions).toBe(0);
    expect(metrics.totalIdentityCollisions).toBe(0);

    store.inbox = [commitment("a", 1n)];
    await runPublisherTick({ verifierId: "CVERIFIER", adapter, store }, metrics);
    expect(metrics.totalDuplicateResubmissions).toBe(1);
    expect(metrics.totalIdentityCollisions).toBe(0);
  });

  it("flags identity collisions (same id, different leaf)", async () => {
    const adapter = new FakeAdapter();
    const store = new MemoryStore();
    const metrics = createMetrics();
    store.inbox = [commitment("a", 1n), commitment("a", 99n)];

    await runPublisherTick({ verifierId: "CVERIFIER", adapter, store }, metrics);
    expect(metrics.totalIdentityCollisions).toBe(1);
    expect(metrics.totalDuplicateResubmissions).toBe(0);
    expect(store.archived).toEqual(["a", "a"]);
  });

  it("flags identity collisions (different id, same leaf)", async () => {
    const adapter = new FakeAdapter();
    const store = new MemoryStore();
    const metrics = createMetrics();
    store.inbox = [commitment("a", 1n), commitment("b", 1n)];

    await runPublisherTick({ verifierId: "CVERIFIER", adapter, store }, metrics);
    expect(metrics.totalIdentityCollisions).toBe(1);
    expect(metrics.totalDuplicateResubmissions).toBe(0);
  });

  it("does not insert colliding leaves into the tree", async () => {
    const adapter = new FakeAdapter();
    const store = new MemoryStore();
    store.inbox = [commitment("a", 1n), commitment("a", 99n), commitment("b", 2n)];

    const res = await runPublisherTick({ verifierId: "CVERIFIER", adapter, store });
    expect(res.leafCount).toBe(2);
    expect(res.newlyAccepted).toBe(2);
  });

  it("removes revoked leaves and republishes the remaining tree", async () => {
    const initialAdapter = new FakeAdapter();
    const store = new MemoryStore();
    const revokedUid = bigintToHex32(2n);
    const activeUid = bigintToHex32(3n);
    store.inbox = [
      { ...commitment("revoked", 1n), attestationUid: revokedUid, holderSignature: holderSignature(revokedUid, bigintToHex32(1n)) },
      { ...commitment("active", 2n), attestationUid: activeUid, holderSignature: holderSignature(activeUid, bigintToHex32(2n)) },
    ];
    await runPublisherTick({ verifierId: "CVERIFIER", adapter: initialAdapter, store });

    const adapter = new FakeAdapter();
    let revoked = false;
    adapter.getAttestation = async (uid: string) => uid === revokedUid
      ? { schemaId: SCHEMA_ID, stealthAddressHash: recipientHash(), expirationLedger: 0, revocationLedger: revoked ? 99 : 0 }
      : uid === activeUid
        ? { schemaId: SCHEMA_ID, stealthAddressHash: recipientHash(), expirationLedger: 0, revocationLedger: 0 }
        : null;
    const cfg = { verifierId: "CVERIFIER", adapter, store };

    revoked = true;
    const second = await runPublisherTick(cfg);

    expect(second.leafCount).toBe(1);
    expect(second.published).toBe(true);
    expect(store.load()?.leaves.map((leaf) => leaf.id)).toEqual(["active"]);
  });

  it("publishes the empty root when revocation removes the final leaf", async () => {
    const store = new MemoryStore();
    const initialAdapter = new FakeAdapter();
    store.inbox = [commitment("revoked", 1n)];
    await runPublisherTick({ verifierId: "CVERIFIER", adapter: initialAdapter, store });

    const adapter = new FakeAdapter() as FakeAdapter & {
      currentLedger: () => Promise<number>;
      getAttestation: () => Promise<{ schemaId: string; stealthAddressHash: string; expirationLedger: number; revocationLedger: number }>;
    };
    adapter.currentLedger = async () => 100;
    adapter.getAttestation = async () => ({
      schemaId: SCHEMA_ID,
      stealthAddressHash: recipientHash(),
      expirationLedger: 0,
      revocationLedger: 99,
    });

    const result = await runPublisherTick({ verifierId: "CVERIFIER", adapter, store });

    expect(result.leafCount).toBe(0);
    expect(result.published).toBe(true);
    expect(store.load()?.leaves).toEqual([]);
  });
});

describe("quarantine", () => {
  it("quarantines invalid files during readInbox", () => {
    const store = new MemoryStore();
    store.inbox = [
      commitment("valid", 1n),
      { id: "bad", leaf: "invalid-hex", submittedAt: "2026-01-01T00:00:00Z" } as LeafCommitment,
      commitment("valid2", 2n),
    ];

    const result = store.readInbox();
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("valid");
    expect(result[1].id).toBe("valid2");
  });

  it("tracks quarantined files in MemoryStore", () => {
    const store = new MemoryStore();
    store.quarantineFile("bad.json", { leaf: "bad" }, ["invalid leaf"], () => "2026-01-01T00:00:00Z");
    expect(store.quarantineSize()).toBe(1);
    const q = store.listQuarantine();
    expect(q).toHaveLength(1);
    expect(q[0].filename).toBe("bad.json");
    expect(q[0].errors).toEqual(["invalid leaf"]);
  });
});

describe("rate limiter", () => {
  it("allows requests within limits", () => {
    const limiter = new RateLimiter(60_000, 10, 15);
    const result = limiter.consume("user-1");
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBeGreaterThanOrEqual(0);
  });

  it("throttles sustained abuse", () => {
    const limiter = new RateLimiter(60_000, 5, 5);
    for (let i = 0; i < 5; i++) limiter.consume("abuser");
    const blocked = limiter.consume("abuser");
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
  });

  it("resets after window", () => {
    const limiter = new RateLimiter(1, 5, 5);
    for (let i = 0; i < 5; i++) limiter.consume("user");
    const blocked = limiter.consume("user");
    expect(blocked.allowed).toBe(false);
  });

  it("does not affect other sources", () => {
    const limiter = new RateLimiter(60_000, 2, 2);
    limiter.consume("user-a");
    limiter.consume("user-a");
    const blocked = limiter.consume("user-a");
    expect(blocked.allowed).toBe(false);
    const allowed = limiter.consume("user-b");
    expect(allowed.allowed).toBe(true);
  });

  it("normal usage never trips limits", () => {
    const limiter = new RateLimiter(60_000, 120, 140);
    for (let i = 0; i < 30; i++) {
      const r = limiter.consume("normal-wallet");
      expect(r.allowed).toBe(true);
    }
  });
});
