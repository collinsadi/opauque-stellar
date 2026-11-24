/**
 * Historical manifest + inclusion-path lookups (issue #972).
 *
 * The ASP publishes one file per root (`data/sets/<poolId>/<root>.json`, pruned to
 * the most recent `maxSetsPerPool`) but only ever served `latest.json`. A
 * withdrawing user whose proof references an older root had no way to fetch that
 * root's manifest, and no way to obtain the inclusion path for their own label —
 * `AssociationSet.manifest()` documents that "clients look the label's position up
 * in the published manifest", but there was no endpoint to do it with, so they had
 * to reconstruct the whole tree from every approved deposit index themselves.
 *
 * Kept free of HTTP and chain concerns so the routing and proof assembly can be
 * unit-tested directly.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MerkleTree, getPoseidon, toHex32 } from "./merkle.ts";
import type { SetManifest } from "./types.ts";

/** A published root is a 0x-prefixed 32-byte hex string. Also the only shape accepted as a path segment. */
const ROOT_RE = /^0x[0-9a-fA-F]{64}$/;

/** A label is a decimal BN254 field element. */
const LABEL_RE = /^\d{1,78}$/;

export type ManifestRouteResult = {
  status: number;
  body: unknown;
};

export type InclusionProof = {
  /** Root the proof was computed against (0x-prefixed 32-byte hex). */
  root: string;
  /** The label proven, decimal string. */
  label: string;
  /** Tree-leaf position of the label within this root's set. */
  index: number;
  /** Deposit index the label was approved for, when the manifest records it. */
  depositIndex: number | null;
  levels: number;
  /** Bottom-up sibling path, decimal field elements — the circuit's `aspSiblings`. */
  pathElements: string[];
  /** Direction bits — the circuit's `aspIndex`. */
  pathIndices: number[];
};

export function isValidRoot(value: string): boolean {
  return ROOT_RE.test(value);
}

export function isValidLabel(value: string): boolean {
  return LABEL_RE.test(value);
}

function manifestPath(dataDir: string, poolId: string, file: string): string {
  return join(dataDir, "sets", poolId, file);
}

function loadManifest(dataDir: string, poolId: string, file: string): SetManifest | null {
  const p = manifestPath(dataDir, poolId, file);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as SetManifest;
  } catch {
    return null;
  }
}

/**
 * Filename for a root. Roots are written lowercase by `toHex32`, so an
 * uppercase request has to be normalized to find the same file.
 */
function rootFile(root: string): string {
  return `${root.toLowerCase()}.json`;
}

/** `GET /manifest` — the current manifest (`latest.json`). */
export function readLatestManifest(dataDir: string, poolId: string): ManifestRouteResult {
  const manifest = loadManifest(dataDir, poolId, "latest.json");
  if (!manifest) {
    return { status: 404, body: { ok: false, error: "no manifest published yet" } };
  }
  return { status: 200, body: manifest };
}

/**
 * `GET /manifest/:root` — a specific historical root.
 *
 * The root is validated against `ROOT_RE` before it is joined into a path, so a
 * crafted segment can never escape the set directory. Roots dropped by the
 * retention policy are indistinguishable from roots that never existed, and both
 * answer 404.
 */
export function readManifestByRoot(dataDir: string, poolId: string, root: string): ManifestRouteResult {
  if (!isValidRoot(root)) {
    return { status: 400, body: { ok: false, error: "root must be a 0x-prefixed 32-byte hex string" } };
  }
  const manifest = loadManifest(dataDir, poolId, rootFile(root));
  if (!manifest) {
    return {
      status: 404,
      body: {
        ok: false,
        error: "no manifest retained for that root",
        detail:
          "Roots are pruned to the most recent set files per pool. Re-publish the root, or prove against a root this ASP still retains.",
      },
    };
  }
  return { status: 200, body: manifest };
}

/**
 * `GET /inclusion/:root/:label` — the label's inclusion path for a given root.
 *
 * Deprecated for clients (#1080): requesting a single label tells the ASP
 * operator which deposit is about to be withdrawn. The SDK now fetches the whole
 * manifest (`GET /manifest/:root`) and computes the path locally; this endpoint
 * is kept only for explicitly opted-in legacy callers.
 *
 * The tree is rebuilt from the manifest's own label list, so the returned path is
 * bound to that root by construction: it cannot be served for a different set.
 */
export async function readInclusion(
  dataDir: string,
  poolId: string,
  root: string,
  label: string,
): Promise<ManifestRouteResult> {
  if (!isValidRoot(root)) {
    return { status: 400, body: { ok: false, error: "root must be a 0x-prefixed 32-byte hex string" } };
  }
  if (!isValidLabel(label)) {
    return { status: 400, body: { ok: false, error: "label must be a decimal field element" } };
  }

  const manifest = loadManifest(dataDir, poolId, rootFile(root));
  if (!manifest) {
    return {
      status: 404,
      body: { ok: false, error: "no manifest retained for that root" },
    };
  }

  const labels = Array.isArray(manifest.labels) ? manifest.labels : [];
  // Compared defensively: one unparseable label in a corrupt manifest must not
  // turn every other label's lookup into a 500.
  let index = -1;
  for (let i = 0; i < labels.length; i += 1) {
    try {
      if (BigInt(labels[i]!) === BigInt(label)) {
        index = i;
        break;
      }
    } catch {
      // Not a field element — cannot be the requested label.
    }
  }
  if (index < 0) {
    return {
      status: 404,
      body: {
        ok: false,
        error: "label is not in this root's association set",
        root: manifest.root,
        size: labels.length,
      },
    };
  }

  const poseidon = await getPoseidon();
  const tree = new MerkleTree(poseidon, manifest.levels);
  for (const l of labels) tree.insert(BigInt(l));
  // Recompute rather than trust the filename: a served proof must belong to the
  // root it is served under.
  const computedRoot = toHex32(tree.root());
  if (computedRoot.toLowerCase() !== manifest.root.toLowerCase()) {
    return {
      status: 500,
      body: { ok: false, error: "manifest root does not match its own label set" },
    };
  }

  const { pathElements, pathIndices } = tree.proof(index);
  const proof: InclusionProof = {
    root: manifest.root,
    label,
    index,
    depositIndex: Array.isArray(manifest.indices) ? manifest.indices[index] ?? null : null,
    levels: manifest.levels,
    pathElements: pathElements.map((e) => e.toString()),
    pathIndices,
  };
  return { status: 200, body: proof };
}
