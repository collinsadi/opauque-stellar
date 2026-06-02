/**
 * Reputation prover — orchestrates witness generation (WASM) and
 * ZK proof generation (snarkjs) for stealth attestations.
 *
 * Also provides the on-chain submit helper that calls the
 * ReputationVerifier Soroban contract.
 */

import type { OpaqueWasmModule } from "../hooks/useOpaqueWasm";
import type { ProofData, DiscoveredTrait } from "./reputation";
import { buildSingleLeafMerkleTree } from "./merkle";
import { reputationAddresses } from "../contracts/reputationAddresses";
import { BASE_FEE, Contract, TransactionBuilder, nativeToScVal } from "@stellar/stellar-sdk";
import { bytesToScVal, getSorobanServer, invokeContractMethod, u64ToScVal } from "./stellar";
import type { SignTxFn } from "./stellar";
import { getNetworkPassphrase } from "./chain";
// @ts-expect-error snarkjs has no bundled types
import * as snarkjs from "snarkjs";

const CIRCUIT_WASM_PATH = "/circuits/stealth_attestation_js/stealth_attestation.wasm";
const ZKEY_PATH = "/circuits/sa_final.zkey";
const TREE_DEPTH = 20;

const REPUTATION_CONTRACT_ID = reputationAddresses.reputationVerifier;

export type ProofProgressCallback = (stage: string, percent: number) => void;

function bytesToBigInt(bytes: Uint8Array): bigint {
  let result = 0n;
  for (const b of bytes) result = (result << 8n) + BigInt(b);
  return result;
}

async function buildCircuitConsistentWitness(
  traitAttestationId: number,
  stealthPrivKeyBytes: Uint8Array,
  externalNullifier: string,
) {
  if (typeof globalThis !== "undefined" && !("Buffer" in globalThis)) {
    const bufferPkg = await import("buffer/index.js");
    (globalThis as { Buffer?: typeof bufferPkg.Buffer }).Buffer = bufferPkg.Buffer;
  }
  const circomlib = await import("circomlibjs");
  const poseidon = await circomlib.buildPoseidon();
  const babyjub = await circomlib.buildBabyjub();
  const F = poseidon.F;

  const attestationId = BigInt(traitAttestationId);
  const extNullifier = BigInt(externalNullifier);

  const stealthPriv = F.toObject(F.e(bytesToBigInt(stealthPrivKeyBytes)));
  const ephemeralPriv = F.toObject(F.e(stealthPriv + extNullifier + 1n));
  const stealthPub = babyjub.mulPointEscalar(babyjub.Base8, stealthPriv);
  const ephemeralPub = babyjub.mulPointEscalar(babyjub.Base8, ephemeralPriv);
  const sharedSecret = babyjub.mulPointEscalar(ephemeralPub, stealthPriv);

  const stealthPubX = F.toObject(stealthPub[0]);
  const stealthPubY = F.toObject(stealthPub[1]);
  const ephemeralPubX = F.toObject(ephemeralPub[0]);
  const ephemeralPubY = F.toObject(ephemeralPub[1]);
  const sharedX = F.toObject(sharedSecret[0]);
  const sharedY = F.toObject(sharedSecret[1]);

  const addressCommitment = F.toObject(poseidon([sharedX, sharedY, stealthPubX, stealthPubY]));
  const leaf = F.toObject(poseidon([addressCommitment, attestationId]));

  const ph = (inputs: bigint[]): bigint => F.toObject(poseidon(inputs)) as bigint;
  const { root: merkleRoot, path: merklePath, pathIndices: merklePathIndices } =
    buildSingleLeafMerkleTree(leaf as bigint, TREE_DEPTH, ph);

  return {
    merkle_root: merkleRoot.toString(),
    attestation_id: attestationId.toString(),
    external_nullifier: extNullifier.toString(),
    stealth_private_key: stealthPriv.toString(),
    ephemeral_pubkey: [ephemeralPubX.toString(), ephemeralPubY.toString()],
    announcement_attestation_id: attestationId.toString(),
    merkle_path_elements: merklePath.map((h) => h.toString()),
    merkle_path_indices: merklePathIndices,
  };
}

/**
 * Full proof generation pipeline:
 * 1. Generate witness via WASM
 * 2. Generate Groth16 proof via snarkjs
 */
export async function generateReputationProof(
  _wasm: OpaqueWasmModule,
  trait: DiscoveredTrait,
  _allAttestationsJson: string,
  stealthPrivKeyBytes: Uint8Array,
  externalNullifier: string,
  onProgress: ProofProgressCallback,
): Promise<ProofData> {
  onProgress("preparing-witness", 10);

  const witness = await buildCircuitConsistentWitness(
    trait.attestationId,
    stealthPrivKeyBytes,
    externalNullifier
  );

  onProgress("preparing-witness", 70);
  onProgress("generating-proof", 75);

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    witness,
    CIRCUIT_WASM_PATH,
    ZKEY_PATH,
  );

  onProgress("generating-proof", 95);

  // V1 public signal order (canonical — see docs/PUBLIC_SIGNALS.md):
  //   [0] nullifier  [1] is_valid  [2] merkle_root  [3] attestation_id
  //   [4] external_nullifier. Must match circuits/stealth_attestation.circom
  //   and contracts/reputation-verifier.
  const nullifier = publicSignals[0];
  const attestationIdFromProof = Number(publicSignals[3]);
  const isValidSignal = String(publicSignals[1] ?? "0");

  if (isValidSignal !== "1") {
    console.error("❌ [Opaque] Generated proof has is_valid=0.", {
      traitId: trait.attestationId,
      publicSignals,
      witness,
    });
    throw new Error(
      "Generated proof is invalid (is_valid=0). Rescan traits and regenerate."
    );
  }

  return {
    proof: {
      pi_a: proof.pi_a.slice(0, 2),
      pi_b: proof.pi_b.slice(0, 2),
      pi_c: proof.pi_c.slice(0, 2),
    },
    publicSignals,
    nullifier,
    attestationId: Number.isFinite(attestationIdFromProof) ? attestationIdFromProof : trait.attestationId,
  };
}

// =============================================================================
// On-chain submission (Stellar Soroban)
// =============================================================================

function bigIntToBytes32(val: bigint): Uint8Array {
  const bytes = new Uint8Array(32);
  let n = val;
  for (let i = 31; i >= 0; i--) {
    bytes[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return bytes;
}

/**
 * Fetch the latest valid Merkle root from the on-chain root history
 * by simulating the `get_latest_root` view function on the ReputationVerifier contract.
 */
export async function fetchLatestValidMerkleRoot(sourcePublicKey: string): Promise<Uint8Array> {
  const server = getSorobanServer();
  const passphrase = getNetworkPassphrase();
  const source = await server.getAccount(sourcePublicKey);
  const contract = new Contract(REPUTATION_CONTRACT_ID);
  let tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: passphrase,
  })
    .addOperation(contract.call("get_latest_root"))
    .setTimeout(30)
    .build();
  tx = await server.prepareTransaction(tx);
  const sim = await server.simulateTransaction(tx);
  if (!("result" in sim) || !sim.result) {
    throw new Error("No valid Merkle root available — contract may not be initialized or root has expired.");
  }
  const retval = sim.result.retval;
  const v = retval as { bytes?: () => Buffer };
  if (!v.bytes) {
    throw new Error("Unexpected response from contract when fetching Merkle root.");
  }
  const rootBytes = Uint8Array.from(v.bytes());
  const isZero = rootBytes.every((b) => b === 0);
  if (isZero) {
    throw new Error("Latest Merkle root is invalid (all zeros).");
  }
  return rootBytes;
}

/**
 * Submits a proof to the ReputationVerifier Soroban contract.
 */
export async function submitProofOnChain(
  proofData: ProofData,
  merkleRoot: string,
  externalNullifier: string,
  signTransaction: SignTxFn,
  publicKey: string,
): Promise<string> {
  const rootBytes = bigIntToBytes32(BigInt(merkleRoot));
  const nullifierBytes = bigIntToBytes32(BigInt(proofData.nullifier));

  const pi_a = proofData.proof.pi_a.map(BigInt);
  const pi_b_flat = proofData.proof.pi_b.flatMap((pair) => [BigInt(pair[1]), BigInt(pair[0])]);
  const pi_c = proofData.proof.pi_c.map(BigInt);

  const proofA = new Uint8Array(64);
  proofA.set(bigIntToBytes32(pi_a[0]), 0);
  proofA.set(bigIntToBytes32(pi_a[1]), 32);
  const proofB = new Uint8Array(128);
  for (let i = 0; i < 4; i++) proofB.set(bigIntToBytes32(pi_b_flat[i]), i * 32);
  const proofC = new Uint8Array(64);
  proofC.set(bigIntToBytes32(pi_c[0]), 0);
  proofC.set(bigIntToBytes32(pi_c[1]), 32);

  return invokeContractMethod({
    sourcePublicKey: publicKey,
    contractId: REPUTATION_CONTRACT_ID,
    method: "verify_reputation",
    args: [
      nativeToScVal(publicKey, { type: "address" }),
      nativeToScVal(reputationAddresses.groth16Verifier, { type: "address" }),
      bytesToScVal(proofA),
      bytesToScVal(proofB),
      bytesToScVal(proofC),
      nativeToScVal(Buffer.from(rootBytes), { type: "bytes" }),
      u64ToScVal(proofData.attestationId),
      u64ToScVal(BigInt(externalNullifier)),
      nativeToScVal(Buffer.from(nullifierBytes), { type: "bytes" }),
    ],
    signTransaction,
  });
}
