/**
 * Privacy-pool browser prover.
 *
 * Withdrawal is proven against the ON-CHAIN PUBLISHED roots (the contract only accepts
 * published state/ASP roots), so the frontend reconstructs the trees from on-chain events
 * — the state tree from `Deposit` + `Withdraw` (remainder) commitments by index, and the
 * ASP tree from deposit labels — and checks the reconstructed roots equal the published
 * ones before proving. If the ASP indexer hasn't yet published a root covering the user's
 * deposit, withdrawal waits.
 *
 * v1 supports FULL withdrawals (remainder = 0): the change commitment is a throwaway
 * zero-value leaf. Partial withdrawals (change re-noted) are a documented follow-up; the
 * contract + circuit already support them.
 */
import {
  Address,
  BASE_FEE,
  Contract,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { keccak_256 } from "@noble/hashes/sha3";
import { proveInWorker } from "./proofWorkerClient";
import { getSorobanServer } from "./stellar";
import { getNetwork, getNetworkPassphrase } from "./chain";
import {
  NoteCommitmentMismatchError,
  NoteNotIndexedError,
  PoolNotDeployedError,
  PoolRootsStaleError,
  PoolRootsUnpublishedError,
  ProofArtifactUnavailableError,
  ProofGenerationError,
  SimulationFailedError,
} from "./errors";
import { getActiveManifest } from "../contracts/deploymentManifest";
import { getPoolConfig } from "../contracts/poolConfig";
import { publicAssetPath } from "./publicAssets";
import {
  BN254_R,
  POOL_TREE_DEPTH,
  getPoseidon,
  hashFields,
  newNoteSecrets,
  toHex32,
  type PoolNote,
} from "./poolNotes";

const WASM_PATH = publicAssetPath("circuits/v3/privacy_pool_withdraw.wasm");
const ZKEY_PATH = publicAssetPath("circuits/v3/privacy_pool_withdraw_final.zkey");
const EVENT_LOOKBACK = 16000;

function parseOldestLedgerFromRangeError(err: unknown): number | null {
  let msg = "";
  if (err instanceof Error) msg = err.message;
  else if (typeof err === "string") msg = err;
  else if (err && typeof err === "object") {
    const o = err as { message?: unknown };
    msg = typeof o.message === "string" ? o.message : "";
  }
  const m = /ledger range:\s*(\d+)\s*-\s*(\d+)/.exec(msg);
  return m ? Number(m[1]) : null;
}

async function poolEventStartLedger(server: rpc.Server): Promise<number> {
  const latest = (await server.getLatestLedger()).sequence;
  const deployedAt = getActiveManifest()?.deploymentLedger;
  let start = deployedAt && deployedAt > 0 ? deployedAt : Math.max(1, latest - EVENT_LOOKBACK);
  try {
    const health = await server.getHealth();
    const oldest = Number(health.oldestLedger);
    if (start < oldest) start = oldest;
  } catch {
    /* health unavailable */
  }
  return start;
}

function toBE32(v: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let n = v;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

function beBytes(v: bigint, len: number): Uint8Array {
  const out = new Uint8Array(len);
  let n = v;
  for (let i = len - 1; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

// ── depth-20 Poseidon Merkle tree (byte-matches the contract/circuit/ASP) ──
class MerkleTree {
  private zero: bigint[];
  private poseidon: never;
  private leaves: bigint[];
  private depth: number;
  constructor(poseidon: never, leaves: bigint[], depth = POOL_TREE_DEPTH) {
    this.poseidon = poseidon;
    this.leaves = leaves;
    this.depth = depth;
    this.zero = [0n];
    for (let i = 0; i < depth; i++) {
      this.zero.push(hashFields(this.poseidon, [this.zero[i], this.zero[i]]));
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

type PoolEvents = {
  /** Commitment field element at each state-tree leaf index (deposits + remainders). */
  stateLeaves: bigint[];
  /** State-tree leaf index of each DEPOSIT, in event order (== ASP-tree leaf order). */
  depositIndices: number[];
};

async function readPoolEvents(poolId: string): Promise<PoolEvents> {
  const server = getSorobanServer();
  let startLedger = await poolEventStartLedger(server);
  const depositTopic = xdr.ScVal.scvSymbol("Deposit").toXDR("base64");
  const withdrawTopic = xdr.ScVal.scvSymbol("Withdraw").toXDR("base64");

  const byIndex = new Map<number, bigint>();
  const depositIndices: number[] = [];

  for (const [topic, isDeposit] of [
    [depositTopic, true],
    [withdrawTopic, false],
  ] as const) {
    let cursor: string | undefined;
    let prevCursor: string | undefined;
    const filters = [{ type: "contract" as const, contractIds: [poolId], topics: [[topic, "*"]] }];
    // Soroban getEvents pages through the ledger range ~10k ledgers at a time and
    // returns many EMPTY pages before the ones that actually hold events. Follow
    // the cursor until it stops advancing (we have caught up to latestLedger);
    // breaking on the first short/empty page would miss every deposit that sits
    // beyond the first page.
    for (let page = 0; page < 200; page++) {
      let res: rpc.Api.GetEventsResponse;
      try {
        const req: rpc.Server.GetEventsRequest = cursor
          ? { cursor, filters, limit: 100 }
          : { startLedger, filters, limit: 100 };
        res = await server.getEvents(req);
      } catch (err) {
        const oldest = parseOldestLedgerFromRangeError(err);
        if (!cursor && oldest != null && startLedger < oldest) {
          startLedger = oldest;
          res = await server.getEvents({ startLedger, filters, limit: 100 });
        } else {
          throw err;
        }
      }
      for (const ev of res.events ?? []) {
        const data = scValToNative(ev.value) as unknown[];
        if (isDeposit) {
          // (commitment, index, value, scope)
          const commitment = BigInt("0x" + Buffer.from(data[0] as Uint8Array).toString("hex"));
          const index = Number(data[1]);
          byIndex.set(index, commitment);
          depositIndices.push(index);
        } else {
          // (nullifier_hash, new_commitment, index, withdrawn_value)
          const newCommitment = BigInt("0x" + Buffer.from(data[1] as Uint8Array).toString("hex"));
          const index = Number(data[2]);
          byIndex.set(index, newCommitment);
        }
      }
      cursor = res.cursor;
      if (!cursor || cursor === prevCursor) break;
      prevCursor = cursor;
    }
  }

  const max = byIndex.size === 0 ? -1 : Math.max(...byIndex.keys());
  const stateLeaves: bigint[] = [];
  for (let i = 0; i <= max; i++) stateLeaves.push(byIndex.get(i) ?? 0n);
  depositIndices.sort((a, b) => a - b);
  return { stateLeaves, depositIndices };
}

/** Read the latest published root (state or ASP) via a read-only simulation. */
async function latestRoot(poolId: string, sourcePublicKey: string, state: boolean): Promise<Uint8Array | null> {
  const server = getSorobanServer();
  try {
    const source = await server.getAccount(sourcePublicKey);
    const tx = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: getNetworkPassphrase() })
      .addOperation(new Contract(poolId).call("get_latest_root", xdr.ScVal.scvBool(state)))
      .setTimeout(30)
      .build();
    const sim = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim) || !sim.result?.retval) return null;
    const native = scValToNative(sim.result.retval) as Uint8Array;
    return Uint8Array.from(native);
  } catch {
    return null;
  }
}

export type WithdrawProof = {
  proofA: Uint8Array;
  proofB: Uint8Array;
  proofC: Uint8Array;
  withdrawnValue: bigint;
  stateRoot: Uint8Array;
  aspRoot: Uint8Array;
  nullifierHash: Uint8Array;
  newCommitment: Uint8Array;
};

/** keccak256(recipient_xdr ∥ withdrawn(16) ∥ fee(16) ∥ relayer_xdr ∥ scope(8)) mod r. */
export function computeContext(
  recipient: string,
  withdrawn: bigint,
  fee: bigint,
  relayer: string,
  scope: number,
): bigint {
  const recXdr = new Uint8Array(new Address(recipient).toScVal().toXDR());
  const relXdr = new Uint8Array(new Address(relayer).toScVal().toXDR());
  const parts = [recXdr, beBytes(withdrawn, 16), beBytes(fee, 16), relXdr, beBytes(BigInt(scope), 8)];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const preimage = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    preimage.set(p, o);
    o += p.length;
  }
  const digest = keccak_256(preimage);
  let v = 0n;
  for (const b of digest) v = (v << 8n) + BigInt(b);
  return v % BN254_R;
}

function serializeProof(proof: { pi_a: string[]; pi_b: string[][]; pi_c: string[] }): {
  a: Uint8Array;
  b: Uint8Array;
  c: Uint8Array;
} {
  const a = new Uint8Array(64);
  a.set(toBE32(BigInt(proof.pi_a[0])), 0);
  a.set(toBE32(BigInt(proof.pi_a[1])), 32);
  const b = new Uint8Array(128);
  const flat = proof.pi_b.slice(0, 2).flatMap((p) => [BigInt(p[1]), BigInt(p[0])]);
  for (let i = 0; i < 4; i++) b.set(toBE32(flat[i]), i * 32);
  const c = new Uint8Array(64);
  c.set(toBE32(BigInt(proof.pi_c[0])), 0);
  c.set(toBE32(BigInt(proof.pi_c[1])), 32);
  return { a, b, c };
}

export type ProofProgress = (stage: string) => void;

/**
 * Generate a full-withdrawal proof for `note`, paying `recipient` (minus `fee` to
 * `relayer`). `caller` is the source account used for read-only simulations.
 * The Groth16 proving step runs in a Web Worker; aborting `signal` cancels it and
 * rejects with an `AbortError`.
 */
export async function generateWithdrawProof(opts: {
  note: PoolNote;
  recipient: string;
  fee: bigint;
  relayer: string;
  caller: string;
  onProgress?: ProofProgress;
  signal?: AbortSignal;
}): Promise<WithdrawProof> {
  const cfg = getPoolConfig();
  if (!cfg) {
    throw new PoolNotDeployedError({
      message: "Privacy pool is not deployed on this network.",
      network: getNetwork(),
    });
  }
  const { note } = opts;
  const value = BigInt(note.value);
  const withdrawnValue = value; // full withdrawal
  const remainder = 0n;
  opts.onProgress?.("reading-chain");

  const poseidon = await getPoseidon();
  const h = (xs: bigint[]) => hashFields(poseidon as never, xs);

  // Reconstruct trees from on-chain events.
  const { stateLeaves, depositIndices } = await readPoolEvents(cfg.poolId);
  const label = h([BigInt(cfg.scope), BigInt(note.leafIndex)]);
  const aspLeaves = depositIndices.map((i) => h([BigInt(cfg.scope), BigInt(i)]));
  const aspLeafIndex = depositIndices.indexOf(note.leafIndex);
  const indexed = depositIndices.length > 0 ? depositIndices.join(", ") : "none";
  if (aspLeafIndex < 0) {
    throw new NoteNotIndexedError({
      message:
        `Leaf #${note.leafIndex} is not a current pool Deposit event. Indexed deposits: ${indexed}. ` +
        "Select the note created by your latest deposit, or clear/import notes if this one is stale.",
      leafIndex: note.leafIndex,
      indexedLeafIndices: depositIndices,
      context: { poolId: cfg.poolId },
    });
  }
  const onChainCommitment = stateLeaves[note.leafIndex] != null
    ? toHex32(stateLeaves[note.leafIndex]).toLowerCase()
    : null;
  if (onChainCommitment && onChainCommitment !== note.commitment.toLowerCase()) {
    throw new NoteCommitmentMismatchError({
      message:
        `Leaf #${note.leafIndex} exists, but this note's commitment does not match the current pool. ` +
        "This note is probably from an older deposit or pool deployment.",
      leafIndex: note.leafIndex,
      expectedCommitment: note.commitment.toLowerCase(),
      onChainCommitment,
      context: { poolId: cfg.poolId },
    });
  }

  const stateTree = new MerkleTree(poseidon as never, stateLeaves);
  const aspTree = new MerkleTree(poseidon as never, aspLeaves);
  const statePath = stateTree.proof(note.leafIndex);
  const aspPath = aspTree.proof(aspLeafIndex);

  // Use the PUBLISHED roots; they must equal our reconstruction or the contract rejects.
  opts.onProgress?.("checking-roots");
  const publishedState = await latestRoot(cfg.poolId, opts.caller, true);
  const publishedAsp = await latestRoot(cfg.poolId, opts.caller, false);
  if (!publishedState || !publishedAsp) {
    throw new PoolRootsUnpublishedError({
      message: "No published pool roots yet — the ASP indexer must publish first.",
      poolId: cfg.poolId,
      hasStateRoot: publishedState !== null,
      hasAspRoot: publishedAsp !== null,
    });
  }
  const reconStateRoot = toBE32(stateTree.root());
  const reconAspRoot = toBE32(aspTree.root());
  const eq = (x: Uint8Array, y: Uint8Array) => x.length === y.length && x.every((b, i) => b === y[i]);
  const stateRootMatches = eq(reconStateRoot, publishedState);
  const aspRootMatches = eq(reconAspRoot, publishedAsp);
  if (!stateRootMatches || !aspRootMatches) {
    throw new PoolRootsStaleError({
      message:
        "Published roots don't yet cover your deposit (ASP indexer is behind). Try again shortly.",
      poolId: cfg.poolId,
      stateRootMatches,
      aspRootMatches,
    });
  }

  // Throwaway change commitment (remainder = 0 in v1).
  const change = newNoteSecrets();
  const newPrecommit = h([BigInt(change.nullifier), BigInt(change.secret)]);
  const newCommitment = h([remainder, label, newPrecommit]);
  const nullifierHash = h([BigInt(note.nullifier)]);
  const context = computeContext(opts.recipient, withdrawnValue, opts.fee, opts.relayer, cfg.scope);

  const input = {
    withdrawnValue: withdrawnValue.toString(),
    stateRoot: stateTree.root().toString(),
    aspRoot: aspTree.root().toString(),
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
    aspSiblings: aspPath.siblings.map((x) => x.toString()),
    aspIndex: aspPath.indices.map((x) => x.toString()),
  };

  opts.onProgress?.("proving");
  let proof: { pi_a: string[]; pi_b: string[][]; pi_c: string[] };
  try {
    ({ proof } = await proveInWorker({
      input,
      wasmPath: WASM_PATH,
      zkeyPath: ZKEY_PATH,
      signal: opts.signal,
    }));
  } catch (err) {
    // A user cancel is not a proof failure; let it reach the caller unchanged.
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    // A missing/short-served artifact and a genuine proving failure need
    // different remedies, so they get different classes.
    const message = err instanceof Error ? err.message : String(err);
    if (/fetch|network|404|not found|unexpected end|invalid|magic/i.test(message)) {
      throw new ProofArtifactUnavailableError({
        message: `Could not load the withdrawal circuit artifacts: ${message}`,
        artifact: /zkey/i.test(message) ? ZKEY_PATH : WASM_PATH,
        cause: err,
      });
    }
    throw new ProofGenerationError({
      message: `Withdrawal proof generation failed: ${message}`,
      circuit: "privacy_pool_withdraw",
      cause: err,
      context: { poolId: cfg.poolId, leafIndex: note.leafIndex },
    });
  }
  const { a, b, c } = serializeProof(proof);

  return {
    proofA: a,
    proofB: b,
    proofC: c,
    withdrawnValue,
    stateRoot: publishedState,
    aspRoot: publishedAsp,
    nullifierHash: toBE32(nullifierHash),
    newCommitment: toBE32(newCommitment),
  };
}

/** Latest published state/ASP roots (hex) for status display; null if absent. */
export async function fetchPoolRoots(
  caller: string,
): Promise<{ stateRoot: string | null; aspRoot: string | null }> {
  const cfg = getPoolConfig();
  if (!cfg) return { stateRoot: null, aspRoot: null };
  const toHex = (u: Uint8Array | null) =>
    u ? "0x" + Array.from(u).map((x) => x.toString(16).padStart(2, "0")).join("") : null;
  const [s, a] = await Promise.all([
    latestRoot(cfg.poolId, caller, true),
    latestRoot(cfg.poolId, caller, false),
  ]);
  return { stateRoot: toHex(s), aspRoot: toHex(a) };
}

/** Read the next deposit leaf index (the value `deposit` will assign). */
export async function fetchNextLeafIndex(caller: string): Promise<number> {
  const cfg = getPoolConfig();
  if (!cfg) {
    throw new PoolNotDeployedError({
      message: "Privacy pool is not deployed on this network.",
      network: getNetwork(),
    });
  }
  const server = getSorobanServer();
  const source = await server.getAccount(caller);
  const tx = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: getNetworkPassphrase() })
    .addOperation(new Contract(cfg.poolId).call("get_deposit_count"))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim) || !sim.result?.retval) {
    throw new SimulationFailedError({
      message: "Could not read pool deposit count.",
      contractId: cfg.poolId,
      method: "get_deposit_count",
      contractError: rpc.Api.isSimulationError(sim) ? sim.error : null,
    });
  }
  return Number(scValToNative(sim.result.retval));
}

/** Native pool balance (stroops) via the SAC `balance` view. */
export async function fetchPoolBalance(caller: string): Promise<bigint> {
  const cfg = getPoolConfig();
  if (!cfg) return 0n;
  const server = getSorobanServer();
  const source = await server.getAccount(caller);
  const tx = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: getNetworkPassphrase() })
    .addOperation(new Contract(cfg.nativeSac).call("balance", nativeToScVal(cfg.poolId, { type: "address" })))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim) || !sim.result?.retval) return 0n;
  return BigInt(scValToNative(sim.result.retval) as bigint);
}
