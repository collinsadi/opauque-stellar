/**
 * Reputation prover: build the V2 witness (Poseidon) and generate a Groth16
 * proof via snarkjs, returning a bundle ready for on-chain verification.
 *
 * Witness fields and the Merkle path are supplied from the holder's attestation
 * and the publisher's inclusion endpoint. Public-signal order is canonical:
 *   [0] merkle_root  [1] attestation_id  [2] external_nullifier  [3] nullifier_hash
 */
import { bigIntToBytes32, bytesToBigInt } from "../crypto/bytes";
import { getPoseidon } from "../crypto/notes";
import { ArtifactError } from "../errors/index";
import type { ArtifactResolver } from "../artifacts/index";
import type { VerifyReputationInputs } from "../contracts/verifier";
import { serializeGroth16Proof } from "./serialize";
import { runProofJobs, type ProofPoolOptions } from "./worker-pool";

const TREE_DEPTH = 20;

type PoseidonField = {
  e(x: bigint): unknown;
  toObject(x: unknown): bigint;
};

export interface ReputationProveInput {
  /** Schema id field (32-byte hex, bigint, or numeric compatibility value). */
  attestationId: number | bigint | string;
  /** The holder's stealth private key bytes. */
  stealthPrivKey: Uint8Array;
  /** Application-chosen external nullifier (must fit in u64 for the contract). */
  externalNullifier: bigint;
  /** Private fields used to create the actual V2 leaf. */
  attestationWitness: {
    issuerPkX: bigint | string;
    traitDataHash: bigint | string;
    nonce: bigint | string;
  };
  /** Inclusion response from GET /v1/reputation/root/:leaf. */
  publisherProof: {
    root: string;
    pathElements: string[];
    pathIndices: number[];
  };
}

export interface ReputationWitnessV2 {
  stealth_pk: string;
  schema_id: string;
  issuer_pk_x: string;
  trait_data_hash: string;
  nonce: string;
  merkle_path: string[];
  merkle_path_indices: number[];
  merkle_root: string;
  attestation_id: string;
  external_nullifier: string;
  nullifier_hash: string;
}

function field(value: bigint | number | string): bigint {
  return typeof value === "bigint" ? value : BigInt(value);
}

/** Build the canonical V2 reputation witness from the attestation and publisher path. */
export async function buildReputationWitnessV2(
  input: ReputationProveInput,
): Promise<ReputationWitnessV2> {
  const poseidon = (await getPoseidon()) as unknown as ((i: bigint[]) => unknown) & {
    F: PoseidonField;
  };
  const F = poseidon.F;

  const stealthPk = F.toObject(F.e(bytesToBigInt(input.stealthPrivKey)));
  const schemaId = field(input.attestationId);
  const extNullifier = input.externalNullifier;

  const issuerPkX = F.toObject(F.e(field(input.attestationWitness.issuerPkX)));
  const traitDataHash = F.toObject(F.e(field(input.attestationWitness.traitDataHash)));
  const nonce = F.toObject(F.e(field(input.attestationWitness.nonce)));

  const leaf = F.toObject(
    poseidon([stealthPk, schemaId, issuerPkX, traitDataHash, nonce]),
  );

  const { root, pathElements, pathIndices } = input.publisherProof;
  if (pathElements.length !== TREE_DEPTH || pathIndices.length !== TREE_DEPTH) {
    throw new TypeError(`publisher proof must contain exactly ${TREE_DEPTH} path elements and indices`);
  }
  let current = leaf;
  const merklePath = pathElements.map((element, index) => {
    const sibling = F.toObject(F.e(field(element)));
    const direction = pathIndices[index];
    if (direction !== 0 && direction !== 1) {
      throw new TypeError("publisher proof path indices must be 0 or 1");
    }
    current = F.toObject(direction === 0
      ? poseidon([current, sibling])
      : poseidon([sibling, current]));
    return sibling.toString();
  });
  const merkleRoot = F.toObject(F.e(field(root)));
  if (current !== merkleRoot) {
    throw new TypeError("publisher proof path does not match its root for the supplied attestation fields");
  }
  const nullifierHash = F.toObject(poseidon([stealthPk, extNullifier]));

  return {
    stealth_pk: stealthPk.toString(),
    schema_id: schemaId.toString(),
    issuer_pk_x: issuerPkX.toString(),
    trait_data_hash: traitDataHash.toString(),
    nonce: nonce.toString(),
    merkle_path: merklePath,
    merkle_path_indices: [...pathIndices],
    merkle_root: merkleRoot.toString(),
    attestation_id: schemaId.toString(),
    external_nullifier: extNullifier.toString(),
    nullifier_hash: nullifierHash.toString(),
  };
}

interface SnarkjsLike {
  groth16: {
    fullProve(
      input: Record<string, unknown>,
      wasm: string | Uint8Array,
      zkey: string | Uint8Array,
    ): Promise<{ proof: import("./serialize").Groth16ProofLike; publicSignals: string[] }>;
  };
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

export interface ReputationProof extends VerifyReputationInputs {
  publicSignals: string[];
}

/**
 * Generate a V2 reputation proof and return a bundle ready for
 * `reputation.verifyOnChain` / the reputation-verifier contract.
 */
export async function proveReputationV2(opts: {
  input: ReputationProveInput;
  artifacts: ArtifactResolver;
  snarkjs?: SnarkjsLike;
}): Promise<ReputationProof> {
  const witness = await buildReputationWitnessV2(opts.input);
  const snarkjs = opts.snarkjs ?? (await loadSnarkjs());
  const [wasm, zkey] = await Promise.all([
    opts.artifacts.resolve("reputation-v2", "wasm"),
    opts.artifacts.resolve("reputation-v2", "zkey"),
  ]);

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    witness as unknown as Record<string, unknown>,
    wasm,
    zkey,
  );
  const { a, b, c } = serializeGroth16Proof(proof);

  return {
    proofA: a,
    proofB: b,
    proofC: c,
    merkleRoot: bigIntToBytes32(BigInt(publicSignals[0])),
    attestationId: bigIntToBytes32(BigInt(publicSignals[1])),
    externalNullifier: opts.input.externalNullifier,
    nullifierHash: bigIntToBytes32(BigInt(publicSignals[3])),
    publicSignals,
  };
}

/**
 * Generate V2 reputation proofs for several independent inputs. Parallelizes
 * the CPU-heavy `fullProve` calls across a worker pool when one is available
 * (same fallback rules as {@link import("./pool").provePoolWithdrawBatch}); the
 * serial path is exactly {@link proveReputationV2} called in a loop, so results
 * are identical either way for the same inputs.
 */
export async function proveReputationV2Batch(opts: {
  inputs: ReputationProveInput[];
  artifacts: ArtifactResolver;
  snarkjs?: SnarkjsLike;
  /** `false` forces serial proving; omit to auto-detect a worker pool. */
  pool?: ProofPoolOptions | false;
}): Promise<ReputationProof[]> {
  const witnesses = await Promise.all(opts.inputs.map(buildReputationWitnessV2));
  const [wasm, zkey] = await Promise.all([
    opts.artifacts.resolve("reputation-v2", "wasm"),
    opts.artifacts.resolve("reputation-v2", "zkey"),
  ]);

  const results = await runProofJobs(
    witnesses.map((w) => ({ input: w as unknown as Record<string, unknown>, wasm, zkey })),
    { snarkjs: opts.snarkjs, pool: opts.pool },
  );

  return results.map((r, i) => {
    const { a, b, c } = serializeGroth16Proof(r.proof);
    return {
      proofA: a,
      proofB: b,
      proofC: c,
      merkleRoot: bigIntToBytes32(BigInt(r.publicSignals[0])),
      attestationId: bigIntToBytes32(BigInt(r.publicSignals[1])),
      externalNullifier: opts.inputs[i].externalNullifier,
      nullifierHash: bigIntToBytes32(BigInt(r.publicSignals[3])),
      publicSignals: r.publicSignals,
    };
  });
}
