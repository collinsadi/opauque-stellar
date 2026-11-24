/**
 * ASP client for withdrawal proving (#972, #1080, #1081).
 *
 * A withdrawer has to prove their label is in the association set for one
 * specific root — the `aspRoot` the pool contract currently holds. The SDK
 * fetches that root's whole published manifest (`GET /manifest/:root`) and
 * computes the label's inclusion path locally (#1080). It never sends its label
 * to the ASP by default: a per-label request (`GET /inclusion/:root/:label`)
 * would tell the ASP operator which deposit is about to be withdrawn, and from
 * where, before the withdrawal lands.
 *
 * Everything stays self-authenticating: the manifest's labels must hash to the
 * requested root (and, when an ASP public key is configured, the manifest must
 * carry a valid Ed25519 signature from that key — #1081), so a compromised or
 * buggy ASP still cannot forge an inclusion.
 */
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha2";
import { StrKey } from "@stellar/stellar-sdk";
import { GatewayError } from "../errors/index";
import { POOL_TREE_DEPTH, getPoseidon, hashFields } from "../crypto/notes";
import { bytesToHex, hexToBytes } from "../crypto/bytes";
import { PoolMerkleTree } from "./pool";

/**
 * Depth of the association tree in the withdraw circuit
 * (`PrivacyPoolWithdraw(20, 64)`: `aspSiblings[levels]`, `aspIndex[levels]`).
 */
export const ASP_TREE_DEPTH = POOL_TREE_DEPTH;

/** One label's inclusion path, in the withdraw circuit's input types. */
export interface AspInclusionProof {
  /** Root the proof was computed against, 0x-prefixed 32-byte hex. */
  root: string;
  /** The proven label, decimal field element. */
  label: string;
  /** Tree-leaf position within the set. */
  index: number;
  /** Deposit index the label was approved for, when the manifest records it. */
  depositIndex?: number | null;
  levels: number;
  /** Bottom-up sibling path — the circuit's `aspSiblings`. */
  pathElements: string[];
  /** Direction bits (`"0"` / `"1"`) — the circuit's `aspIndex`. */
  pathIndices: string[];
}

/** A set manifest as published by the ASP. */
export interface AspSetManifest {
  poolId: string;
  root: string;
  version: number;
  levels: number;
  algo: string;
  labels: string[];
  indices: number[];
  generatedAt: string;
  /** sha256 binding `root` to `labels`; the value the ASP posts on-chain (#1081). */
  datasetHash?: string;
  /** Screening policy that produced the set (#1081). */
  policy?: string;
  /** Ledger the set reflects (#1081). */
  ledger?: number;
  /** Stellar G-address of the key that signed the manifest (#1081). */
  signer?: string;
  /** Hex Ed25519 signature over {@link canonicalAspManifestBytes} (#1081). */
  signature?: string;
}

/** Default per-request timeout for ASP HTTP calls. */
export const DEFAULT_ASP_TIMEOUT_MS = 10_000;

const ROOT_RE = /^0x[0-9a-fA-F]{64}$/;
const LABEL_RE = /^\d{1,78}$/;

export interface FetchAspManifestOptions {
  baseUrl: string;
  poolId: string;
  root: string;
  /**
   * The ASP's published Ed25519 public key (Stellar G-address). When set, the
   * manifest must be signed by it or the fetch fails (#1081).
   */
  aspPublicKey?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface FetchAspInclusionOptions extends FetchAspManifestOptions {
  /** The caller's label, decimal field element. Never sent to the ASP by default. */
  label: string;
  /**
   * Opt in to the legacy `GET /inclusion/:root/:label` endpoint instead of
   * computing the path from the full manifest. This reveals the label — and so
   * the deposit being withdrawn — to the ASP operator (#1080). Default `false`.
   */
  revealLabelToAsp?: boolean;
}

function url(path: string, base: string): string {
  return new URL(path, base.endsWith("/") ? base : `${base}/`).toString();
}

async function getJson<T>(
  target: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)];
  if (signal) signals.push(signal);
  const res = await fetch(target, {
    headers: { accept: "application/json" },
    signal: AbortSignal.any(signals),
  });
  if (!res.ok) {
    throw new GatewayError(`ASP returned ${res.status} for ${target}`, {
      httpStatus: res.status,
      gatewayUrl: target,
    });
  }
  return (await res.json()) as T;
}

function assertRoot(root: string): void {
  if (!ROOT_RE.test(root)) {
    throw new Error(`asp root must be a 0x-prefixed 32-byte hex string, got "${root}"`);
  }
}

function assertLabel(label: string): void {
  if (!LABEL_RE.test(label)) {
    throw new Error(`asp label must be a decimal field element, got "${label}"`);
  }
}

function assertCircuitDepth(levels: number): void {
  if (levels !== ASP_TREE_DEPTH) {
    throw new Error(
      `ASP tree depth ${levels} does not match the withdraw circuit's depth ${ASP_TREE_DEPTH}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Manifest signatures (#1081). Must stay byte-identical to asp/src/publish.ts;
// both sides are tested against sdk/tests/fixtures/asp-signed-manifest.json.
// ---------------------------------------------------------------------------

/** Domain separator of the ASP manifest signature encoding. */
export const ASP_MANIFEST_SIGNATURE_DOMAIN = "opaque-asp-manifest/v1";

const utf8 = new TextEncoder();

function be32(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n >>> 0, false);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function fieldToBytes32(value: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = value;
  for (let i = 31; i >= 0; i -= 1) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** sha256(BE32(count) || root || BE32-byte label...) — the ASP's on-chain dataset hash. */
export function computeAspDatasetHash(root: string, labels: string[]): string {
  return (
    "0x" +
    bytesToHex(
      sha256(concat([be32(labels.length), hexToBytes(root), ...labels.map((l) => fieldToBytes32(BigInt(l)))])),
    )
  );
}

function indicesHash(indices: number[]): string {
  return "0x" + bytesToHex(sha256(concat([be32(indices.length), ...indices.map(be32)])));
}

/**
 * Canonical, delimited encoding of a manifest's signed fields: each field is a
 * UTF-8 string prefixed by its BE32 byte length, in a fixed order after a
 * versioned domain separator. Labels are bound through `datasetHash`.
 */
export function canonicalAspManifestBytes(manifest: AspSetManifest): Uint8Array {
  const fields = [
    ASP_MANIFEST_SIGNATURE_DOMAIN,
    manifest.poolId,
    manifest.root.toLowerCase(),
    String(manifest.version),
    String(manifest.levels),
    manifest.algo,
    (manifest.datasetHash ?? "").toLowerCase(),
    manifest.policy ?? "",
    String(manifest.ledger ?? ""),
    manifest.generatedAt,
    String(manifest.labels.length),
    indicesHash(manifest.indices),
  ];
  return concat(
    fields.map((f) => {
      const bytes = utf8.encode(f);
      return concat([be32(bytes.length), bytes]);
    }),
  );
}

/**
 * True if `manifest` is signed by `aspPublicKey` (Stellar G-address) and its
 * `datasetHash` matches its own root + labels. Needs only the public key.
 */
export function verifyAspManifestSignature(manifest: AspSetManifest, aspPublicKey: string): boolean {
  try {
    if (!manifest.signature || manifest.signer !== aspPublicKey) return false;
    if (!/^[0-9a-fA-F]{128}$/.test(manifest.signature)) return false;
    if (!Array.isArray(manifest.labels) || !Array.isArray(manifest.indices)) return false;
    if (manifest.labels.length !== manifest.indices.length || !manifest.datasetHash) return false;
    if (computeAspDatasetHash(manifest.root, manifest.labels) !== manifest.datasetHash.toLowerCase()) {
      return false;
    }
    return ed25519.verify(
      hexToBytes(manifest.signature),
      canonicalAspManifestBytes(manifest),
      StrKey.decodeEd25519PublicKey(aspPublicKey),
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Inclusion paths
// ---------------------------------------------------------------------------

/**
 * Recompute the root implied by an inclusion proof and check it equals the root
 * the proof claims and has the circuit's depth. Mirrors the circuit's inclusion
 * check: start at the leaf and fold in each sibling in `pathIndices` order.
 */
export async function assertAspInclusionMatchesRoot(proof: AspInclusionProof): Promise<void> {
  if (proof.pathElements.length !== proof.pathIndices.length) {
    throw new Error(
      `ASP inclusion proof is malformed: ${proof.pathElements.length} path elements vs ${proof.pathIndices.length} indices`,
    );
  }
  if (proof.pathElements.length !== proof.levels) {
    throw new Error(
      `ASP inclusion proof covers ${proof.pathElements.length} levels, expected ${proof.levels}`,
    );
  }
  assertCircuitDepth(proof.levels);

  const poseidon = await getPoseidon();
  let computed = BigInt(proof.label);
  for (let level = 0; level < proof.pathElements.length; level += 1) {
    const bit = String(proof.pathIndices[level]);
    if (bit !== "0" && bit !== "1") {
      throw new Error(`ASP inclusion proof has a non-binary path index at level ${level}`);
    }
    const sibling = BigInt(proof.pathElements[level]!);
    computed =
      bit === "1"
        ? hashFields(poseidon, [sibling, computed])
        : hashFields(poseidon, [computed, sibling]);
  }

  if (computed !== BigInt(proof.root)) {
    throw new Error(
      `ASP inclusion proof does not reproduce its root: computed 0x${computed.toString(16)}, proof claims ${proof.root}`,
    );
  }
}

/**
 * Compute `label`'s inclusion path from a full ASP manifest, locally (#1080).
 *
 * Rebuilds the association tree from the manifest's labels and refuses a
 * manifest whose labels do not hash to its root (or to `expectedRoot`, when
 * given), or whose depth differs from the withdraw circuit's.
 */
export async function computeAspInclusionFromManifest(
  manifest: AspSetManifest,
  label: string,
  opts: { expectedRoot?: string } = {},
): Promise<AspInclusionProof> {
  assertLabel(label);
  assertRoot(manifest.root);
  assertCircuitDepth(manifest.levels);
  if (opts.expectedRoot !== undefined && BigInt(opts.expectedRoot) !== BigInt(manifest.root)) {
    throw new Error(`ASP served the manifest for ${manifest.root}, not the requested root ${opts.expectedRoot}`);
  }
  if (!Array.isArray(manifest.labels)) throw new Error("ASP manifest has no labels");

  const leaves = manifest.labels.map((l, i) => {
    if (!LABEL_RE.test(l)) throw new Error(`ASP manifest label #${i} is not a decimal field element`);
    return BigInt(l);
  });
  const target = BigInt(label);
  const index = leaves.findIndex((l) => l === target);
  if (index < 0) {
    throw new Error("Label is not in this root's association set; it may not be approved yet.");
  }

  const tree = new PoolMerkleTree(await getPoseidon(), leaves, manifest.levels);
  if (tree.root() !== BigInt(manifest.root)) {
    throw new Error("ASP manifest labels do not hash to the manifest's root.");
  }
  const { siblings, indices } = tree.proof(index);
  return {
    root: manifest.root,
    label,
    index,
    depositIndex: Array.isArray(manifest.indices) ? (manifest.indices[index] ?? null) : null,
    levels: manifest.levels,
    pathElements: siblings.map((s) => s.toString()),
    pathIndices: indices.map((i) => i.toString()),
  };
}

/**
 * Get the inclusion path for `label` at `root` (#972, #1080).
 *
 * By default this fetches the whole manifest for `root` and computes the path
 * locally, so the ASP never learns which label is being proven. The result is
 * verified against `root` and the circuit depth before it is returned, and
 * against `aspPublicKey` when one is given.
 */
export async function fetchAspInclusion(
  opts: FetchAspInclusionOptions,
): Promise<AspInclusionProof> {
  assertRoot(opts.root);
  assertLabel(opts.label);

  if (opts.revealLabelToAsp) {
    const served = await getJson<Omit<AspInclusionProof, "pathIndices"> & { pathIndices: Array<number | string> }>(
      url(
        `inclusion/${encodeURIComponent(opts.root)}/${encodeURIComponent(opts.label)}`,
        opts.baseUrl,
      ),
      opts.timeoutMs ?? DEFAULT_ASP_TIMEOUT_MS,
      opts.signal,
    );
    const proof: AspInclusionProof = {
      ...served,
      pathIndices: (served.pathIndices ?? []).map((i) => String(i)),
    };
    if (BigInt(proof.root) !== BigInt(opts.root) || proof.label !== opts.label) {
      throw new Error("ASP served an inclusion proof for a different root or label.");
    }
    await assertAspInclusionMatchesRoot(proof);
    return proof;
  }

  const manifest = await fetchAspManifest(opts);
  return computeAspInclusionFromManifest(manifest, opts.label, { expectedRoot: opts.root });
}

/**
 * Fetch a specific historical manifest by root (`GET /manifest/:root`). When
 * `aspPublicKey` is set, the manifest must carry a valid signature from it.
 */
export async function fetchAspManifest(opts: FetchAspManifestOptions): Promise<AspSetManifest> {
  assertRoot(opts.root);
  const manifest = await getJson<AspSetManifest>(
    url(`manifest/${encodeURIComponent(opts.root)}`, opts.baseUrl),
    opts.timeoutMs ?? DEFAULT_ASP_TIMEOUT_MS,
    opts.signal,
  );
  if (opts.aspPublicKey !== undefined && !verifyAspManifestSignature(manifest, opts.aspPublicKey)) {
    throw new Error(`ASP manifest for ${opts.root} is not signed by ${opts.aspPublicKey}`);
  }
  return manifest;
}
