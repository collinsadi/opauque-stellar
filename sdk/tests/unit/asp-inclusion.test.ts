/**
 * #972 / #1080 / #1081 — the SDK consumes the ASP's historical manifests.
 *
 * Covers the client itself (fetching `GET /manifest/:root` and computing the
 * label's path locally, so the label is never sent to the ASP; the root and
 * signature checks that keep the result self-authenticating) and the prover's
 * use of that path in place of rebuilding the tree from every deposit index.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  assertAspInclusionMatchesRoot,
  buildPoolWithdrawWitness,
  deriveDeposit,
  computeAspInclusionFromManifest,
  fetchAspInclusion,
  fetchAspManifest,
  verifyAspManifestSignature,
  type AspSetManifest,
  type AspInclusionProof,
  type PoolNote,
} from "../../src/index";
import { getPoseidon, hashFields } from "../../src/crypto/notes";
import signedVector from "../fixtures/asp-signed-manifest.json";

/** Manifest signed by the ASP's `signManifest` (asp/test/manifest-signing.test.ts checks the same vector). */
const SIGNED = signedVector as { publicKey: string; manifest: AspSetManifest };

const RECIPIENT = "GCMPINZMMQVQ7MWIJLB34F5JRAHLQQTWCP6XB5HEZR353PPPWRUWHLPU";
const RELAYER = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ";
const SCOPE = 1;
const DEPTH = 20;
const LEAF_INDEX = 3;
/** The pool holds deposits 0..4, so the association set has five labels. */
const DEPOSIT_INDICES = [0, 1, 2, 3, 4];

afterEach(() => {
  vi.unstubAllGlobals();
});

function toHex32(v: bigint): string {
  return "0x" + v.toString(16).padStart(64, "0");
}

/** Zero subtree hashes, matching the SDK/ASP/circuit convention. */
async function zeroHashes(levels: number): Promise<bigint[]> {
  const poseidon = await getPoseidon();
  const zeros = [0n];
  for (let i = 0; i < levels; i += 1) {
    zeros.push(hashFields(poseidon, [zeros[i]!, zeros[i]!]));
  }
  return zeros;
}

/** The label the ASP set holds for a given deposit index. */
async function labelFor(depositIndex: number): Promise<bigint> {
  const poseidon = await getPoseidon();
  return hashFields(poseidon, [BigInt(SCOPE), BigInt(depositIndex)]);
}

/** Build a real inclusion path for `leafIndex` within a set of labels. */
async function buildPath(
  labels: bigint[],
  leafIndex: number,
): Promise<{ root: bigint; pathElements: bigint[]; pathIndices: number[] }> {
  const poseidon = await getPoseidon();
  const zeros = await zeroHashes(DEPTH);

  const node = (start: number, level: number): bigint => {
    if (start >= labels.length) return zeros[level]!;
    if (level === 0) return labels[start]!;
    const half = 1 << (level - 1);
    return hashFields(poseidon, [node(start, level - 1), node(start + half, level - 1)]);
  };

  const pathElements: bigint[] = [];
  const pathIndices: number[] = [];
  let cur = leafIndex;
  for (let level = 0; level < DEPTH; level += 1) {
    pathElements.push(node((cur ^ 1) * (1 << level), level));
    pathIndices.push(cur & 1);
    cur >>= 1;
  }
  return { root: node(0, DEPTH), pathElements, pathIndices };
}

function toProof(
  label: bigint,
  root: bigint,
  pathElements: bigint[],
  pathIndices: number[],
  index: number,
): AspInclusionProof {
  return {
    root: toHex32(root),
    label: label.toString(),
    index,
    depositIndex: index,
    levels: DEPTH,
    pathElements: pathElements.map((e) => e.toString()),
    pathIndices: pathIndices.map(String),
  };
}

/** Serve `body` with `status` for any request, recording the requested URLs. */
function stubFetch(seen: string[], status: number, body: unknown): void {
  vi.stubGlobal("fetch", async (input: string | URL) => {
    seen.push(String(input));
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response;
  });
}

/** A published manifest for `labels`, as the ASP serves it from `GET /manifest/:root`. */
function manifestFor(labels: bigint[], root: bigint) {
  return {
    poolId: "7",
    root: toHex32(root),
    version: labels.length,
    levels: DEPTH,
    algo: "poseidon-bn254",
    labels: labels.map((l) => l.toString()),
    indices: DEPOSIT_INDICES,
    generatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("fetchAspInclusion computes the path locally (#1080)", () => {
  it("fetches the whole manifest, never the label, and returns a root-verified proof", async () => {
    const labels = await Promise.all(DEPOSIT_INDICES.map((i) => labelFor(i)));
    const built = await buildPath(labels, LEAF_INDEX);
    const label = labels[LEAF_INDEX]!.toString();

    const seen: string[] = [];
    stubFetch(seen, 200, manifestFor(labels, built.root));

    const fetched = await fetchAspInclusion({
      baseUrl: "https://asp.example.com",
      poolId: "7",
      root: toHex32(built.root),
      label,
    });

    expect(seen).toEqual([`https://asp.example.com/manifest/${toHex32(built.root)}`]);
    expect(seen.some((u) => u.includes(label) || u.includes("/inclusion/"))).toBe(false);
    expect(fetched.root).toBe(toHex32(built.root));
    expect(fetched.index).toBe(LEAF_INDEX);
    expect(fetched.depositIndex).toBe(LEAF_INDEX);
    expect(fetched.pathElements).toEqual(built.pathElements.map((e) => e.toString()));
    // Path indices are strings, matching the prover's `aspIndex` input.
    expect(fetched.pathIndices).toEqual(built.pathIndices.map((i) => i.toString()));
  });

  it("matches computeAspInclusionFromManifest", async () => {
    const labels = await Promise.all(DEPOSIT_INDICES.map((i) => labelFor(i)));
    const built = await buildPath(labels, 1);
    const local = await computeAspInclusionFromManifest(manifestFor(labels, built.root), labels[1]!.toString());
    await expect(assertAspInclusionMatchesRoot(local)).resolves.toBeUndefined();
  });

  it("normalizes a base URL that has a trailing slash", async () => {
    const labels = await Promise.all(DEPOSIT_INDICES.map((i) => labelFor(i)));
    const built = await buildPath(labels, LEAF_INDEX);

    const seen: string[] = [];
    stubFetch(seen, 200, manifestFor(labels, built.root));

    await fetchAspInclusion({
      baseUrl: "https://asp.example.com/",
      poolId: "7",
      root: toHex32(built.root),
      label: labels[LEAF_INDEX]!.toString(),
    });
    expect(seen[0]!.startsWith("https://asp.example.com/manifest/")).toBe(true);
  });

  it("rejects a manifest whose labels do not hash to its root", async () => {
    const labels = await Promise.all(DEPOSIT_INDICES.map((i) => labelFor(i)));
    const built = await buildPath(labels, LEAF_INDEX);
    const forged = manifestFor(labels, built.root + 1n);
    stubFetch([], 200, forged);

    await expect(
      fetchAspInclusion({
        baseUrl: "https://asp.example.com",
        poolId: "7",
        root: forged.root,
        label: labels[LEAF_INDEX]!.toString(),
      }),
    ).rejects.toThrow(/do not hash to the manifest's root/);
  });

  it("rejects a manifest served for a different root", async () => {
    const labels = await Promise.all(DEPOSIT_INDICES.map((i) => labelFor(i)));
    const built = await buildPath(labels, LEAF_INDEX);
    stubFetch([], 200, manifestFor(labels, built.root));

    await expect(
      fetchAspInclusion({
        baseUrl: "https://asp.example.com",
        poolId: "7",
        root: toHex32(1n),
        label: labels[LEAF_INDEX]!.toString(),
      }),
    ).rejects.toThrow(/not the requested root/);
  });

  it("rejects a manifest whose depth differs from the circuit", async () => {
    const labels = await Promise.all(DEPOSIT_INDICES.map((i) => labelFor(i)));
    const built = await buildPath(labels, LEAF_INDEX);
    stubFetch([], 200, { ...manifestFor(labels, built.root), levels: 16 });

    await expect(
      fetchAspInclusion({
        baseUrl: "https://asp.example.com",
        poolId: "7",
        root: toHex32(built.root),
        label: labels[LEAF_INDEX]!.toString(),
      }),
    ).rejects.toThrow(/circuit's depth 20/);
  });

  it("reports a label that is not in the set", async () => {
    const labels = await Promise.all(DEPOSIT_INDICES.map((i) => labelFor(i)));
    const built = await buildPath(labels, LEAF_INDEX);
    stubFetch([], 200, manifestFor(labels, built.root));

    await expect(
      fetchAspInclusion({
        baseUrl: "https://asp.example.com",
        poolId: "7",
        root: toHex32(built.root),
        label: (await labelFor(99)).toString(),
      }),
    ).rejects.toThrow(/not in this root's association set/);
  });

  it("only calls the per-label endpoint when explicitly opted in, and normalizes its indices", async () => {
    const labels = await Promise.all(DEPOSIT_INDICES.map((i) => labelFor(i)));
    const built = await buildPath(labels, LEAF_INDEX);
    const served = {
      root: toHex32(built.root),
      label: labels[LEAF_INDEX]!.toString(),
      index: LEAF_INDEX,
      depositIndex: LEAF_INDEX,
      levels: DEPTH,
      pathElements: built.pathElements.map((e) => e.toString()),
      pathIndices: built.pathIndices, // the ASP serves numbers
    };
    const seen: string[] = [];
    stubFetch(seen, 200, served);

    const fetched = await fetchAspInclusion({
      baseUrl: "https://asp.example.com",
      poolId: "7",
      root: served.root,
      label: served.label,
      revealLabelToAsp: true,
    });
    expect(seen[0]).toBe(`https://asp.example.com/inclusion/${served.root}/${served.label}`);
    expect(fetched.pathIndices).toEqual(built.pathIndices.map(String));
  });

  it("rejects malformed roots and labels before making a request", async () => {
    const seen: string[] = [];
    stubFetch(seen, 200, {});

    await expect(
      fetchAspInclusion({ baseUrl: "https://asp.example.com", poolId: "7", root: "nope", label: "1" }),
    ).rejects.toThrow(/0x-prefixed 32-byte hex/);
    await expect(
      fetchAspInclusion({
        baseUrl: "https://asp.example.com",
        poolId: "7",
        root: toHex32(1n),
        label: "0x1",
      }),
    ).rejects.toThrow(/decimal field element/);
    expect(seen).toHaveLength(0);
  });

  it("surfaces a non-OK ASP response", async () => {
    stubFetch([], 404, { ok: false, error: "no manifest retained for that root" });
    await expect(
      fetchAspInclusion({
        baseUrl: "https://asp.example.com",
        poolId: "7",
        root: toHex32(1n),
        label: "5",
      }),
    ).rejects.toThrow(/ASP returned 404/);
  });
});

describe("ASP manifest signatures (#1081)", () => {
  it("verifies the shared ASP-signed test vector with only the public key", () => {
    expect(verifyAspManifestSignature(SIGNED.manifest, SIGNED.publicKey)).toBe(true);
  });

  it("rejects another key, a tampered field, and an unsigned manifest", () => {
    expect(verifyAspManifestSignature(SIGNED.manifest, RECIPIENT)).toBe(false);
    expect(verifyAspManifestSignature({ ...SIGNED.manifest, ledger: 1 }, SIGNED.publicKey)).toBe(false);
    expect(
      verifyAspManifestSignature({ ...SIGNED.manifest, labels: [...SIGNED.manifest.labels].reverse() }, SIGNED.publicKey),
    ).toBe(false);
    const { signature: _sig, ...unsigned } = SIGNED.manifest;
    expect(verifyAspManifestSignature(unsigned, SIGNED.publicKey)).toBe(false);
  });

  it("fetchAspInclusion enforces the signature when an ASP key is configured", async () => {
    const m = SIGNED.manifest;
    stubFetch([], 200, m);
    const proof = await fetchAspInclusion({
      baseUrl: "https://asp.example.com",
      poolId: m.poolId,
      root: m.root,
      label: m.labels[2]!,
      aspPublicKey: SIGNED.publicKey,
    });
    expect(proof.index).toBe(2);
    await expect(assertAspInclusionMatchesRoot(proof)).resolves.toBeUndefined();

    stubFetch([], 200, { ...m, policy: "tampered" });
    await expect(
      fetchAspInclusion({
        baseUrl: "https://asp.example.com",
        poolId: m.poolId,
        root: m.root,
        label: m.labels[2]!,
        aspPublicKey: SIGNED.publicKey,
      }),
    ).rejects.toThrow(/not signed by/);
  });
});

describe("fetchAspManifest (#972)", () => {
  it("requests the historical manifest endpoint by root", async () => {
    const root = toHex32(0xabn);
    const seen: string[] = [];
    stubFetch(seen, 200, {
      poolId: "7",
      root,
      version: 3,
      levels: DEPTH,
      algo: "poseidon-bn254",
      labels: [],
      indices: [],
      generatedAt: "2026-01-01T00:00:00.000Z",
    });

    const manifest = await fetchAspManifest({
      baseUrl: "https://asp.example.com",
      poolId: "7",
      root,
    });

    expect(manifest.root).toBe(root);
    expect(seen[0]).toBe(`https://asp.example.com/manifest/${root}`);
  });
});

describe("assertAspInclusionMatchesRoot", () => {
  it("accepts a genuine path", async () => {
    const labels = await Promise.all(DEPOSIT_INDICES.map((i) => labelFor(i)));
    const built = await buildPath(labels, LEAF_INDEX);
    const proof = toProof(labels[LEAF_INDEX]!, built.root, built.pathElements, built.pathIndices, LEAF_INDEX);
    await expect(assertAspInclusionMatchesRoot(proof)).resolves.toBeUndefined();
  });

  it("rejects a path with mismatched element and index counts", async () => {
    await expect(
      assertAspInclusionMatchesRoot({
        root: toHex32(0n),
        label: "1",
        index: 0,
        levels: 2,
        pathElements: ["1"],
        pathIndices: ["0", "1"],
      }),
    ).rejects.toThrow(/malformed/);
  });
});

describe("prover consumes a fetched inclusion path (#972)", () => {
  async function fixture() {
    const secrets = { nullifier: 111n, secret: 222n };
    const deposit = await deriveDeposit({
      value: 1_000_000n,
      scope: SCOPE,
      leafIndex: LEAF_INDEX,
      nullifier: secrets.nullifier,
      secret: secrets.secret,
    });
    const labels = await Promise.all(DEPOSIT_INDICES.map((i) => labelFor(i)));
    const built = await buildPath(labels, LEAF_INDEX);

    const note: PoolNote = {
      cluster: "testnet",
      poolId: "7",
      value: "1000000",
      scope: SCOPE,
      leafIndex: LEAF_INDEX,
      nullifier: secrets.nullifier.toString(),
      secret: secrets.secret.toString(),
      commitment: toHex32(deposit.commitment),
      spent: false,
      createdAt: 0,
    };

    // State leaves: this note's own commitment sits at its leaf index, the rest
    // are unrelated deposits.
    const stateLeaves = DEPOSIT_INDICES.map((i) =>
      i === LEAF_INDEX ? deposit.commitment : BigInt(i) + 1n,
    );

    return { note, stateLeaves, labels, built };
  }

  const base = {
    recipient: RECIPIENT,
    relayer: RELAYER,
    fee: 0n,
    scope: SCOPE,
  };

  it("produces the same association inputs from a fetched path as from a rebuilt tree", async () => {
    const { note, stateLeaves, labels, built } = await fixture();

    const rebuilt = await buildPoolWithdrawWitness({
      ...base,
      note,
      stateLeaves,
      depositIndices: DEPOSIT_INDICES,
    });

    const fetched = await buildPoolWithdrawWitness({
      ...base,
      note,
      stateLeaves,
      // No deposit indices at all — the fetched path is all the prover needs.
      depositIndices: [],
      aspInclusion: {
        root: toHex32(built.root),
        label: labels[LEAF_INDEX]!.toString(),
        pathElements: built.pathElements.map((e) => e.toString()),
        pathIndices: built.pathIndices.map((i) => i.toString()),
      },
    });

    expect(fetched.aspRoot).toBe(rebuilt.aspRoot);
    expect(fetched.input.aspRoot).toBe(rebuilt.input.aspRoot);
    expect(fetched.input.aspSiblings).toEqual(rebuilt.input.aspSiblings);
    expect(fetched.input.aspIndex).toEqual(rebuilt.input.aspIndex);
    // The state half is unaffected by where the ASP path came from.
    expect(fetched.input.stateRoot).toBe(rebuilt.input.stateRoot);
  });

  it("rejects a fetched path that belongs to a different label", async () => {
    const { note, built } = await fixture();
    const otherLabel = await labelFor(9);

    await expect(
      buildPoolWithdrawWitness({
        ...base,
        note,
        stateLeaves: [],
        depositIndices: [],
        aspInclusion: {
          root: toHex32(built.root),
          label: otherLabel.toString(),
          pathElements: built.pathElements.map((e) => e.toString()),
          pathIndices: built.pathIndices.map((i) => i.toString()),
        },
      }),
    ).rejects.toThrow(/different label/);
  });

  it("rejects a fetched path that does not reproduce the root it claims", async () => {
    const { note, stateLeaves, labels, built } = await fixture();

    await expect(
      buildPoolWithdrawWitness({
        ...base,
        note,
        stateLeaves,
        depositIndices: [],
        aspInclusion: {
          root: toHex32(built.root + 1n),
          label: labels[LEAF_INDEX]!.toString(),
          pathElements: built.pathElements.map((e) => e.toString()),
          pathIndices: built.pathIndices.map((i) => i.toString()),
        },
      }),
    ).rejects.toThrow(/does not reproduce the root/);
  });

  it("rejects a fetched path whose depth differs from the circuit (#1080)", async () => {
    const { note, stateLeaves, labels, built } = await fixture();

    await expect(
      buildPoolWithdrawWitness({
        ...base,
        note,
        stateLeaves,
        depositIndices: [],
        aspInclusion: {
          root: toHex32(built.root),
          label: labels[LEAF_INDEX]!.toString(),
          pathElements: built.pathElements.slice(0, 16).map((e) => e.toString()),
          pathIndices: built.pathIndices.slice(0, 16).map((i) => i.toString()),
        },
      }),
    ).rejects.toThrow(/circuit expects 20/);
  });

  it("rejects a fetched path whose elements and indices disagree in length", async () => {
    const { note, stateLeaves, labels, built } = await fixture();

    await expect(
      buildPoolWithdrawWitness({
        ...base,
        note,
        stateLeaves,
        depositIndices: [],
        aspInclusion: {
          root: toHex32(built.root),
          label: labels[LEAF_INDEX]!.toString(),
          pathElements: built.pathElements.slice(0, 4).map((e) => e.toString()),
          pathIndices: built.pathIndices.map((i) => i.toString()),
        },
      }),
    ).rejects.toThrow(/malformed/);
  });
});
