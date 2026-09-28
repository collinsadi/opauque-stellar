/**
 * Privacy-pool note model + cryptographic derivation.
 *
 * A note is the client-side spending material for one pooled commitment. Losing it
 * loses the funds, so notes are persisted (poolNoteStore) and should be included in the
 * wallet's encrypted backup. A note holds only the depositor's own secrets — no other
 * user's data — and reveals nothing on-chain (the commitment is a hash).
 *
 * Derivations (must byte-match circuits/v3 + privacy-pool):
 *   label         = Poseidon(scope, leafIndex)
 *   precommitment = Poseidon(nullifier, secret)
 *   commitment    = Poseidon(value, label, precommitment)
 *   nullifierHash = Poseidon(nullifier)
 */
import { buildPoseidon } from "circomlibjs";

export const POOL_TREE_DEPTH = 20;
export const BN254_R =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

export type PoolNote = {
  /** Network cluster this note belongs to. */
  cluster: string;
  /** Privacy-pool contract this note belongs to. Legacy notes may not have this. */
  poolId?: string;
  /** Wallet public key that created this note. Legacy notes may not have this. */
  account?: string;
  /** Deposited value, in stroops, as a decimal string. */
  value: string;
  /** Domain separator the deposit was made under. */
  scope: number;
  /** Leaf index assigned by the contract at deposit time. */
  leafIndex: number;
  /** Field-element secrets (decimal strings). */
  nullifier: string;
  secret: string;
  /** Derived commitment (0x-prefixed 32-byte hex), the state-tree leaf. */
  commitment: string;
  /** Whether this note has been spent (withdrawn). */
  spent: boolean;
  createdAt: number;
};

let _poseidon: Awaited<ReturnType<typeof buildPoseidon>> | null = null;
export async function getPoseidon() {
  if (!_poseidon) {
    // circomlibjs touches Buffer; ensure it exists in the browser before loading.
    if (typeof globalThis !== "undefined" && !("Buffer" in globalThis)) {
      const bufferPkg = await import("buffer/index.js");
      (globalThis as { Buffer?: typeof bufferPkg.Buffer }).Buffer = bufferPkg.Buffer;
    }
    _poseidon = await buildPoseidon();
  }
  return _poseidon;
}

export function hashFields(poseidon: { F: { toObject: (x: unknown) => bigint } } & ((i: bigint[]) => unknown), inputs: bigint[]): bigint {
  return poseidon.F.toObject(poseidon(inputs));
}

/** bigint -> 0x-prefixed 32-byte big-endian hex. */
export function toHex32(v: bigint): string {
  return "0x" + v.toString(16).padStart(64, "0");
}

/** Cryptographically-random field element < r (decimal string). */
export function randomFieldElement(): string {
  const bytes = new Uint8Array(31);
  crypto.getRandomValues(bytes);
  let v = 0n;
  for (const b of bytes) v = (v << 8n) + BigInt(b);
  return (v % BN254_R).toString();
}

export type DerivedDeposit = {
  label: bigint;
  precommitment: bigint;
  commitment: bigint;
  nullifierHash: bigint;
};

export async function deriveDeposit(opts: {
  value: bigint;
  scope: number;
  leafIndex: number;
  nullifier: bigint;
  secret: bigint;
}): Promise<DerivedDeposit> {
  const poseidon = await getPoseidon();
  const h = (xs: bigint[]) => hashFields(poseidon as never, xs);
  const label = h([BigInt(opts.scope), BigInt(opts.leafIndex)]);
  const precommitment = h([opts.nullifier, opts.secret]);
  const commitment = h([opts.value, label, precommitment]);
  const nullifierHash = h([opts.nullifier]);
  return { label, precommitment, commitment, nullifierHash };
}

/** Build a fresh note's secrets (commitment is filled once the leaf index is known). */
export function newNoteSecrets(): { nullifier: string; secret: string } {
  return { nullifier: randomFieldElement(), secret: randomFieldElement() };
}

/** Unspent total across notes for a cluster, in stroops. */
export function unspentTotal(notes: PoolNote[]): bigint {
  return notes.filter((n) => !n.spent).reduce((sum, n) => sum + BigInt(n.value), 0n);
}
