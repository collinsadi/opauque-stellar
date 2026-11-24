/**
 * Privacy-pool withdrawal prover. Reconstructs the depth-20 Poseidon state/ASP
 * trees from the pool's leaves, assembles the v3 withdrawal witness, and produces
 * a Groth16 proof bundle for `privacy-pool.withdraw`.
 *
 * The Merkle tree and context binding byte-match the circuit and the contract.
 * Reading the on-chain leaves (Deposit/Withdraw events) is the caller's job: pass
 * the reconstructed `stateLeaves` + `depositIndices` (and the prover validates the
 * note against them). This keeps the prover pure and offline-testable.
 *
 * Supports full and partial withdrawals. Partial withdrawals create a fresh
 * change commitment that the caller must persist with the returned secrets.
 */
import { Address } from "@stellar/stellar-sdk";
import { keccak_256 } from "@noble/hashes/sha3";
import { bigIntToBytes32, toHex32 } from "../crypto/bytes";
import {
  BN254_R,
  POOL_TREE_DEPTH,
  getPoseidon,
  hashFields,
  newNoteSecrets,
  type PoolNote,
} from "../crypto/notes";
import { ArtifactError } from "../errors/index";
import type { ArtifactResolver } from "../artifacts/index";
import { serializeGroth16Proof, type Groth16ProofLike } from "./serialize";
import { runProofJobs, type ProofPoolOptions } from "./worker-pool";

type Poseidon = Parameters<typeof hashFields>[0];

/** Big-endian byte encoding of `v` in `len` bytes. */
function beBytes(v: bigint, len: number): Uint8Array {
  const out = new Uint8Array(len);
  let n = v;
  for (let i = len - 1; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

/** Depth-20 Poseidon Merkle tree, byte-matching the contract / circuit / ASP. */
export class PoolMerkleTree {
  private readonly zero: bigint[];
  constructor(
    private readonly poseidon: Poseidon,
    private readonly leaves: bigint[],
    private readonly depth = POOL_TREE_DEPTH,
  ) {
    this.zero = [0n];
    for (let i = 0; i < depth; i++) {
      this.zero.push(hashFields(poseidon, [this.zero[i], this.zero[i]]));
    }
  }
  private rootFrom(start: number, level: number): bigint {
    if (start >= this.leaves.length) return this.zero[level];
    if (level === 0) return this.leaves[start];
    const half = 1 << (level - 1);
    const left = this.rootFrom(start, level - 1);
    const right = this.rootFrom(start + half, level - 1);
    return hashFields(this.poseidon, [left, right]);
  }
  root(): bigint {
    return this.rootFrom(0, this.depth);
  }
  private node(index: number, level: number): bigint {
    return this.rootFrom(index * (1 << level), level);
  }
  proof(index: number): { siblings: bigint[]; indices: number[] } {
    const siblings: bigint[] = [];
    const indices: number[] = [];
    let cur = index;
    for (let level = 0; level < this.depth; level++) {
      siblings.push(this.node(cur ^ 1, level));
      indices.push(cur & 1);
      cur >>= 1;
    }
    return { siblings, indices };
  }
}

/**
 * Withdrawal context binding:
 * keccak256(recipient_xdr ‖ withdrawn(16) ‖ fee(16) ‖ relayer_xdr ‖ scope(8)) mod r.
 */
export function computeWithdrawContext(opts: {
  recipient: string;
  withdrawn: bigint;
  fee: bigint;
  relayer: string;
  scope: number;
}): bigint {
  const recXdr = new Uint8Array(new Address(opts.recipient).toScVal().toXDR());
  const relXdr = new Uint8Array(new Address(opts.relayer).toScVal().toXDR());
  const parts = [
    recXdr,
    beBytes(opts.withdrawn, 16),
    beBytes(opts.fee, 16),
    relXdr,
    beBytes(BigInt(opts.scope), 8),
  ];
  const preimage = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    preimage.set(p, o);
    o += p.length;
  }
  let v = 0n;
  for (const b of keccak_256(preimage)) v = (v << 8n) + BigInt(b);
  return v % BN254_R;
}

export interface PoolWithdrawProof {
  proofA: Uint8Array;
  proofB: Uint8Array;
  proofC: Uint8Array;
  withdrawnValue: bigint;
  stateRoot: Uint8Array;
  aspRoot: Uint8Array;
  nullifierHash: Uint8Array;
  newCommitment: Uint8Array;
  change: { nullifier: string; secret: string; value: bigint };
}

interface SnarkjsLike {
  groth16: {
    fullProve(
      input: Record<string, unknown>,
      wasm: string | Uint8Array,
      zkey: string | Uint8Array,
    ): Promise<{ proof: Groth16ProofLike; publicSignals: string[] }>;
    verify?(vkey: unknown, publicSignals: string[], proof: Groth16ProofLike): Promise<boolean>;
  };
  zKey?: { exportVerificationKey(zkey: string | Uint8Array): Promise<unknown> };
}

export interface ProveProgress { stage: "witness" | "artifacts" | "proving" | "verifying" | "complete"; }
function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Proof generation was cancelled", "AbortError");
}

async function loadSnarkjs(): Promise<SnarkjsLike> {
  try {
    return (await import("snarkjs")) as unknown as SnarkjsLike;
  } catch (cause) {
    throw new ArtifactError(
      "snarkjs is required for proof generation; install it as a peer dependency.",
      { cause },
    );
  }
}

export interface PoolWithdrawWitness {
  /** snarkjs circuit input. */
  input: Record<string, unknown>;
  withdrawnValue: bigint;
  stateRoot: bigint;
  aspRoot: bigint;
  nullifierHash: bigint;
  newCommitment: bigint;
  change: { nullifier: string; secret: string; value: bigint };
}

/**
 * Build the v3 withdrawal witness for `note` — everything `fullProve` needs,
 * short of the circuit artifacts and snarkjs itself. Pulled out of
 * {@link provePoolWithdraw} so batch proving (`provePoolWithdrawBatch`) can
 * build every witness up front and only parallelize the CPU-heavy `fullProve`
 * calls across a worker pool.
 */
/**
 * An inclusion path fetched from the ASP for a specific root (issue #972).
 * Supplying this lets the caller skip reconstructing the association tree from
 * every approved deposit index — it only has to supply their own label's path.
 */
export interface AspWitnessInclusion {
  /** Root the path was computed against; must equal the manifest/ASP root. */
  root: string;
  /** The caller's own label, decimal field element. */
  label: string;
  /** Bottom-up sibling path — the circuit's `aspSiblings`. */
  pathElements: string[];
  /** Direction bits — the circuit's `aspIndex`. */
  pathIndices: string[];
}

export async function buildPoolWithdrawWitness(opts: {
  note: PoolNote;
  recipient: string;
  relayer: string;
  fee: bigint;
  scope: number;
  stateLeaves: bigint[];
  depositIndices: number[];
  withdrawnValue?: bigint;
  /**
   * Pre-fetched ASP inclusion path for this note's label (#972). When given,
   * `depositIndices` is only used to look the label up, not to rebuild the tree.
   */
  aspInclusion?: AspWitnessInclusion;
}): Promise<PoolWithdrawWitness> {
  const { note } = opts;
  const value = BigInt(note.value);
  const withdrawnValue = opts.withdrawnValue ?? value;
  if (withdrawnValue <= 0n || withdrawnValue > value) throw new Error("withdrawnValue must be greater than zero and no greater than the note value");
  const remainder = value - withdrawnValue;

  const poseidon = await getPoseidon();
  const h = (xs: bigint[]) => hashFields(poseidon, xs);

  const label = h([BigInt(opts.scope), BigInt(note.leafIndex)]);
  const stateTree = new PoolMerkleTree(poseidon, opts.stateLeaves);
  const statePath = stateTree.proof(note.leafIndex);

  const onChain = opts.stateLeaves[note.leafIndex];
  if (onChain != null && toHex32(onChain).toLowerCase() !== note.commitment.toLowerCase()) {
    throw new Error(`Leaf #${note.leafIndex} commitment does not match this note.`);
  }

  let aspRoot: bigint;
  let aspSiblings: string[];
  let aspIndex: string[];
  if (opts.aspInclusion) {
    // The ASP already committed to a root and a path for this label; trust neither
    // blindly — the caller-supplied path must reproduce the root it claims, and
    // the label must be the one this note derives.
    const inclusion = opts.aspInclusion;
    if (BigInt(inclusion.label) !== label) {
      throw new Error("ASP inclusion proof is for a different label than this note.");
    }
    if (inclusion.pathElements.length !== inclusion.pathIndices.length) {
      throw new Error("ASP inclusion proof is malformed: path/index length mismatch.");
    }
    if (inclusion.pathElements.length !== POOL_TREE_DEPTH) {
      throw new Error(
        `ASP inclusion proof has ${inclusion.pathElements.length} levels; the withdraw circuit expects ${POOL_TREE_DEPTH}.`,
      );
    }
    let computed = BigInt(inclusion.label);
    for (let level = 0; level < inclusion.pathElements.length; level += 1) {
      const sibling = BigInt(inclusion.pathElements[level]!);
      computed =
        Number(inclusion.pathIndices[level]) === 1
          ? hashFields(poseidon, [sibling, computed])
          : hashFields(poseidon, [computed, sibling]);
    }
    if (computed !== BigInt(inclusion.root)) {
      throw new Error("ASP inclusion proof does not reproduce the root it claims.");
    }
    aspRoot = computed;
    aspSiblings = inclusion.pathElements;
    aspIndex = inclusion.pathIndices;
  } else {
    const aspLeafIndex = opts.depositIndices.indexOf(note.leafIndex);
    if (aspLeafIndex < 0) {
      throw new Error(`Leaf #${note.leafIndex} is not among the pool's deposits.`);
    }
    const aspLeaves = opts.depositIndices.map((i) => h([BigInt(opts.scope), BigInt(i)]));
    const aspTree = new PoolMerkleTree(poseidon, aspLeaves);
    const aspPath = aspTree.proof(aspLeafIndex);
    aspRoot = aspTree.root();
    aspSiblings = aspPath.siblings.map((x) => x.toString());
    aspIndex = aspPath.indices.map((x) => x.toString());
  }

  const change = newNoteSecrets();
  const newPrecommit = h([BigInt(change.nullifier), BigInt(change.secret)]);
  const newCommitment = h([remainder, label, newPrecommit]);
  const nullifierHash = h([BigInt(note.nullifier)]);
  const context = computeWithdrawContext({
    recipient: opts.recipient,
    withdrawn: withdrawnValue,
    fee: opts.fee,
    relayer: opts.relayer,
    scope: opts.scope,
  });

  const input: Record<string, unknown> = {
    withdrawnValue: withdrawnValue.toString(),
    stateRoot: stateTree.root().toString(),
    aspRoot: aspRoot.toString(),
    nullifierHash: nullifierHash.toString(),
    newCommitment: newCommitment.toString(),
    context: context.toString(),
    value: value.toString(),
    label: label.toString(),
    nullifier: note.nullifier,
    secret: note.secret,
    newNullifier: change.nullifier,
    newSecret: change.secret,
    stateSiblings: statePath.siblings.map((x) => x.toString()),
    stateIndex: statePath.indices.map((x) => x.toString()),
    aspSiblings,
    aspIndex,
  };

  return {
    input,
    withdrawnValue,
    stateRoot: stateTree.root(),
    aspRoot,
    nullifierHash,
    newCommitment,
    change: { ...change, value: remainder },
  };
}

function finishPoolWithdrawProof(
  witness: PoolWithdrawWitness,
  proof: Groth16ProofLike,
): PoolWithdrawProof {
  const { a, b, c } = serializeGroth16Proof(proof);
  return {
    proofA: a,
    proofB: b,
    proofC: c,
    withdrawnValue: witness.withdrawnValue,
    stateRoot: bigIntToBytes32(witness.stateRoot),
    aspRoot: bigIntToBytes32(witness.aspRoot),
    nullifierHash: bigIntToBytes32(witness.nullifierHash),
    newCommitment: bigIntToBytes32(witness.newCommitment),
    change: witness.change,
  };
}

/**
 * Generate a full-withdrawal proof for `note`, paying `recipient` (minus `fee` to
 * `relayer`). The caller supplies the reconstructed pool leaves: `stateLeaves`
 * (commitment per state-tree index) and `depositIndices` (state index of each
 * deposit, in ASP-tree order).
 *
 * Alternatively, pass `aspInclusion` — a path fetched from the ASP's
 * `GET /inclusion/:root/:label` endpoint — to prove against a published root
 * without rebuilding the association tree locally (#972).
 */
export async function provePoolWithdraw(opts: {
  note: PoolNote;
  recipient: string;
  relayer: string;
  fee: bigint;
  scope: number;
  stateLeaves: bigint[];
  depositIndices: number[];
  /** Pre-fetched ASP inclusion path for this note's label (#972). */
  aspInclusion?: AspWitnessInclusion;
  withdrawnValue?: bigint;
  artifacts: ArtifactResolver;
  snarkjs?: SnarkjsLike;
  signal?: AbortSignal;
  onProgress?: (progress: ProveProgress) => void;
}): Promise<PoolWithdrawProof> {
  checkAborted(opts.signal); opts.onProgress?.({ stage: "witness" });
  const witness = await buildPoolWithdrawWitness(opts);
  const snarkjs = opts.snarkjs ?? (await loadSnarkjs());
  checkAborted(opts.signal); opts.onProgress?.({ stage: "artifacts" });
  const [wasm, zkey] = await Promise.all([
    opts.artifacts.resolve("pool-v3", "wasm"),
    opts.artifacts.resolve("pool-v3", "zkey"),
  ]);
  checkAborted(opts.signal); opts.onProgress?.({ stage: "proving" });
  const result = await snarkjs.groth16.fullProve(witness.input, wasm, zkey);
  checkAborted(opts.signal);
  if (snarkjs.groth16.verify && snarkjs.zKey?.exportVerificationKey) {
    opts.onProgress?.({ stage: "verifying" });
    const valid = await snarkjs.groth16.verify(await snarkjs.zKey.exportVerificationKey(zkey), result.publicSignals, result.proof);
    if (!valid) throw new Error("Locally generated proof failed Groth16 verification");
  }
  opts.onProgress?.({ stage: "complete" });
  return finishPoolWithdrawProof(witness, result.proof);
}

/** One note to prove in a {@link provePoolWithdrawBatch} call. */
export interface PoolWithdrawBatchJob {
  note: PoolNote;
  recipient: string;
  relayer?: string;
  fee?: bigint;
  scope?: number;
  stateLeaves: bigint[];
  depositIndices: number[];
  /** Pre-fetched ASP inclusion path for this note's label (#972). */
  aspInclusion?: AspWitnessInclusion;
  withdrawnValue?: bigint;
}

/**
 * Generate full-withdrawal proofs for several independent notes. When a worker
 * pool is available (Node `worker_threads` or a browser `Worker`), the
 * CPU-heavy `fullProve` calls run in parallel across it; otherwise (or when
 * `pool: false`) they run serially in-process, one at a time — same code path
 * as {@link provePoolWithdraw}, so results are identical either way for the
 * same inputs. Results are returned in the same order as `jobs`.
 */
export async function provePoolWithdrawBatch(opts: {
  jobs: PoolWithdrawBatchJob[];
  artifacts: ArtifactResolver;
  snarkjs?: SnarkjsLike;
  /** `false` forces serial proving; omit to auto-detect a worker pool. */
  pool?: ProofPoolOptions | false;
  signal?: AbortSignal;
  onProgress?: (completed: number, total: number) => void;
}): Promise<PoolWithdrawProof[]> {
  checkAborted(opts.signal);
  const witnesses = await Promise.all(
    opts.jobs.map((job) =>
      buildPoolWithdrawWitness({
        note: job.note,
        recipient: job.recipient,
        relayer: job.relayer ?? job.recipient,
        fee: job.fee ?? 0n,
        scope: job.scope ?? job.note.scope,
        stateLeaves: job.stateLeaves,
        depositIndices: job.depositIndices,
        aspInclusion: job.aspInclusion,
        withdrawnValue: job.withdrawnValue,
      }),
    ),
  );

  const [wasm, zkey] = await Promise.all([
    opts.artifacts.resolve("pool-v3", "wasm"),
    opts.artifacts.resolve("pool-v3", "zkey"),
  ]);

  const results = await runProofJobs(
    witnesses.map((w) => ({ input: w.input, wasm, zkey })),
    { snarkjs: opts.snarkjs, pool: opts.pool },
  );

  return results.map((r, i) => { checkAborted(opts.signal); opts.onProgress?.(i + 1, results.length); return finishPoolWithdrawProof(witnesses[i], r.proof); });
}
