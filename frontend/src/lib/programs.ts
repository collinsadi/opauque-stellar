/**
 * Soroban contract invocation helpers for Schema Registry, Attestation Engine, Groth16.
 */

import { nativeToScVal, StrKey } from "@stellar/stellar-sdk";
import type { Keypair } from "@stellar/stellar-sdk";
import { deployedAddresses } from "../contracts/deployedAddresses";
import {
  bytesToScVal,
  invokeContractMethod,
  invokeContractWithKeypair,
} from "./stellar";
import type { SignTxFn } from "./stellar";

/** BytesN values use the ScVal Bytes wire representation. */
export function encodeBytesNScVal(value: Uint8Array): ReturnType<typeof nativeToScVal> {
  return nativeToScVal(Buffer.from(value), { type: "bytes" });
}

export function encodeVecScVal(value: unknown[]): ReturnType<typeof nativeToScVal> {
  return nativeToScVal(value);
}

export function encodeMapScVal(value: Record<string, unknown>): ReturnType<typeof nativeToScVal> {
  return nativeToScVal(value);
}

export const SCHEMA_REGISTRY_CONTRACT_ID = deployedAddresses.schemaRegistry;
export const ATTESTATION_ENGINE_V2_CONTRACT_ID = deployedAddresses.attestationEngineV2;
export const GROTH16_VERIFIER_CONTRACT_ID = deployedAddresses.groth16Verifier;

export function bytesToHex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

export async function invokeRegisterSchema(opts: {
  authority: string;
  schemaId: Uint8Array;
  name: string;
  fieldDefinitions: string;
  revocable: boolean;
  version?: number;
  resolver: string | null;
  schemaExpiryLedger: number;
  signTransaction: SignTxFn;
}): Promise<string> {
  const authorityKey = StrKey.decodeEd25519PublicKey(opts.authority);
  const args = [
    nativeToScVal(opts.authority, { type: "address" }),
    nativeToScVal(Buffer.from(authorityKey), { type: "bytes" }),
    nativeToScVal(Buffer.from(opts.schemaId), { type: "bytes" }),
    nativeToScVal(opts.name, { type: "string" }),
    nativeToScVal(opts.fieldDefinitions, { type: "string" }),
    nativeToScVal(opts.revocable, { type: "bool" }),
    nativeToScVal(opts.version ?? 1, { type: "u32" }),
    opts.resolver
      ? nativeToScVal(opts.resolver, { type: "address" })
      : nativeToScVal(null, { type: "address" }),
    nativeToScVal(opts.schemaExpiryLedger, { type: "u32" }),
  ];
  return invokeContractMethod({
    sourcePublicKey: opts.authority,
    contractId: SCHEMA_REGISTRY_CONTRACT_ID,
    method: "register_schema",
    args,
    signTransaction: opts.signTransaction,
  });
}

export async function invokeAttest(opts: {
  issuer: string;
  schemaId: Uint8Array;
  stealthAddressHash: Uint8Array;
  data: Uint8Array;
  expirationLedger: number;
  refUid: Uint8Array;
  signTransaction: SignTxFn;
}): Promise<string> {
  return invokeContractMethod({
    sourcePublicKey: opts.issuer,
    contractId: ATTESTATION_ENGINE_V2_CONTRACT_ID,
    method: "attest",
    args: [
      nativeToScVal(opts.issuer, { type: "address" }),
      nativeToScVal(Buffer.from(opts.schemaId), { type: "bytes" }),
      nativeToScVal(Buffer.from(opts.stealthAddressHash), { type: "bytes" }),
      bytesToScVal(opts.data),
      nativeToScVal(opts.expirationLedger, { type: "u32" }),
      nativeToScVal(Buffer.from(opts.refUid), { type: "bytes" }),
    ],
    signTransaction: opts.signTransaction,
  });
}

export async function invokeRevokeAttestation(opts: {
  revoker: string;
  uid: Uint8Array;
  signTransaction: SignTxFn;
}): Promise<string> {
  return invokeContractMethod({
    sourcePublicKey: opts.revoker,
    contractId: ATTESTATION_ENGINE_V2_CONTRACT_ID,
    method: "revoke_attestation",
    args: [
      nativeToScVal(opts.revoker, { type: "address" }),
      nativeToScVal(Buffer.from(opts.uid), { type: "bytes" }),
    ],
    signTransaction: opts.signTransaction,
  });
}

export async function invokeDeprecateSchema(opts: {
  authority: string;
  schemaId: Uint8Array;
  signTransaction: SignTxFn;
}): Promise<string> {
  return invokeContractMethod({
    sourcePublicKey: opts.authority,
    contractId: SCHEMA_REGISTRY_CONTRACT_ID,
    method: "deprecate_schema",
    args: [
      nativeToScVal(opts.authority, { type: "address" }),
      nativeToScVal(Buffer.from(opts.schemaId), { type: "bytes" }),
    ],
    signTransaction: opts.signTransaction,
  });
}

export async function invokeAddDelegate(opts: {
  authority: string;
  schemaId: Uint8Array;
  delegate: string;
  signTransaction: SignTxFn;
}): Promise<string> {
  if (!StrKey.isValidEd25519PublicKey(opts.delegate)) {
    throw new Error("Delegate must be a valid Stellar account address (G…).");
  }
  return invokeContractMethod({
    sourcePublicKey: opts.authority,
    contractId: SCHEMA_REGISTRY_CONTRACT_ID,
    method: "add_delegate",
    args: [
      nativeToScVal(opts.authority, { type: "address" }),
      nativeToScVal(Buffer.from(opts.schemaId), { type: "bytes" }),
      nativeToScVal(opts.delegate, { type: "address" }),
    ],
    signTransaction: opts.signTransaction,
  });
}

export async function invokeRemoveDelegate(opts: {
  authority: string;
  schemaId: Uint8Array;
  delegate: string;
  signTransaction: SignTxFn;
}): Promise<string> {
  if (!StrKey.isValidEd25519PublicKey(opts.delegate)) {
    throw new Error("Delegate must be a valid Stellar account address (G…).");
  }
  return invokeContractMethod({
    sourcePublicKey: opts.authority,
    contractId: SCHEMA_REGISTRY_CONTRACT_ID,
    method: "remove_delegate",
    args: [
      nativeToScVal(opts.authority, { type: "address" }),
      nativeToScVal(Buffer.from(opts.schemaId), { type: "bytes" }),
      nativeToScVal(opts.delegate, { type: "address" }),
    ],
    signTransaction: opts.signTransaction,
  });
}

export async function invokeVerifyProofV2(opts: {
  caller: string;
  proofA: Uint8Array;
  proofB: Uint8Array;
  proofC: Uint8Array;
  merkleRoot: Uint8Array;
  attestationId: Uint8Array;
  externalNullifier: Uint8Array;
  nullifierHash: Uint8Array;
  signTransaction: SignTxFn;
}): Promise<string> {
  return invokeContractMethod({
    sourcePublicKey: opts.caller,
    contractId: GROTH16_VERIFIER_CONTRACT_ID,
    method: "verify_proof_v2",
    args: [
      nativeToScVal(Buffer.from(opts.proofA), { type: "bytes" }),
      nativeToScVal(Buffer.from(opts.proofB), { type: "bytes" }),
      nativeToScVal(Buffer.from(opts.proofC), { type: "bytes" }),
      nativeToScVal(
        {
          merkle_root: Buffer.from(opts.merkleRoot),
          attestation_id: Buffer.from(opts.attestationId),
          external_nullifier: Buffer.from(opts.externalNullifier),
          nullifier_hash: Buffer.from(opts.nullifierHash),
        },
        { type: "map" },
      ),
    ],
    signTransaction: opts.signTransaction,
  });
}

// ---------------------------------------------------------------------------
// Privacy pool (Phase 5)
// ---------------------------------------------------------------------------

import { getPoolConfig } from "../contracts/poolConfig";
import { getRelayerConfig } from "../contracts/relayerConfig";
import { getNetwork } from "./chain";
import { PoolNotDeployedError, RelayerNotConfiguredError } from "./errors";

function requirePoolId(): string {
  const cfg = getPoolConfig();
  if (!cfg) {
    throw new PoolNotDeployedError({
      message: "Privacy pool is not deployed on this network.",
      network: getNetwork(),
    });
  }
  return cfg.poolId;
}

function requireRelayerRegistryId(): string {
  const cfg = getRelayerConfig();
  if (!cfg) {
    throw new RelayerNotConfiguredError({
      message: "Relayer market is not deployed on this network.",
      network: getNetwork(),
    });
  }
  return cfg.registryId;
}

/** Deposit `value` stroops under a precomputed `commitment` at `expectedIndex`. */
export async function invokePoolDeposit(opts: {
  depositor: string;
  value: bigint;
  commitment: Uint8Array;
  expectedIndex: number;
  signTransaction: SignTxFn;
}): Promise<string> {
  return invokeContractMethod({
    sourcePublicKey: opts.depositor,
    contractId: requirePoolId(),
    method: "deposit",
    args: [
      nativeToScVal(opts.depositor, { type: "address" }),
      nativeToScVal(opts.value, { type: "i128" }),
      bytesToScVal(opts.commitment),
      nativeToScVal(BigInt(opts.expectedIndex), { type: "u64" }),
    ],
    signTransaction: opts.signTransaction,
  });
}

/**
 * Deposit `value` stroops from a stealth account, signing locally with its
 * keypair so the connected wallet is never involved. The stealth account is the
 * transaction source (fee payer) and the `depositor`; source-account auth covers
 * both `deposit`'s `require_auth` and the SAC transfer.
 */
export async function invokePoolDepositWithKeypair(opts: {
  keypair: Keypair;
  value: bigint;
  commitment: Uint8Array;
  expectedIndex: number;
}): Promise<string> {
  return invokeContractWithKeypair({
    keypair: opts.keypair,
    contractId: requirePoolId(),
    method: "deposit",
    args: [
      nativeToScVal(opts.keypair.publicKey(), { type: "address" }),
      nativeToScVal(opts.value, { type: "i128" }),
      bytesToScVal(opts.commitment),
      nativeToScVal(BigInt(opts.expectedIndex), { type: "u64" }),
    ],
  });
}

/** Withdraw `withdrawnValue` to `recipient` (minus `fee` to `relayer`) with a v3 proof. */
export async function invokePoolWithdraw(opts: {
  caller: string;
  proofA: Uint8Array;
  proofB: Uint8Array;
  proofC: Uint8Array;
  withdrawnValue: bigint;
  stateRoot: Uint8Array;
  aspRoot: Uint8Array;
  nullifierHash: Uint8Array;
  newCommitment: Uint8Array;
  recipient: string;
  fee: bigint;
  relayer: string;
  signTransaction: SignTxFn;
}): Promise<string> {
  return invokeContractMethod({
    sourcePublicKey: opts.caller,
    contractId: requirePoolId(),
    method: "withdraw",
    args: [
      bytesToScVal(opts.proofA),
      bytesToScVal(opts.proofB),
      bytesToScVal(opts.proofC),
      nativeToScVal(opts.withdrawnValue, { type: "i128" }),
      bytesToScVal(opts.stateRoot),
      bytesToScVal(opts.aspRoot),
      bytesToScVal(opts.nullifierHash),
      bytesToScVal(opts.newCommitment),
      nativeToScVal(opts.recipient, { type: "address" }),
      nativeToScVal(opts.fee, { type: "i128" }),
      nativeToScVal(opts.relayer, { type: "address" }),
    ],
    signTransaction: opts.signTransaction,
  });
}

/** Publish a tree root (admin only). `kind` selects state vs ASP root. */
export async function invokePoolRoot(opts: {
  admin: string;
  kind: "state" | "asp";
  root: Uint8Array;
  datasetHash: Uint8Array;
  signTransaction: SignTxFn;
}): Promise<string> {
  return invokeContractMethod({
    sourcePublicKey: opts.admin,
    contractId: requirePoolId(),
    method: opts.kind === "state" ? "update_state_root" : "update_asp_root",
    args: [
      nativeToScVal(opts.admin, { type: "address" }),
      bytesToScVal(opts.root),
      bytesToScVal(opts.datasetHash),
    ],
    signTransaction: opts.signTransaction,
  });
}

export const invokeUpdateAspRoot = (opts: {
  admin: string;
  root: Uint8Array;
  datasetHash: Uint8Array;
  signTransaction: SignTxFn;
}) => invokePoolRoot({ ...opts, kind: "asp" });

export const invokeUpdateStateRoot = (opts: {
  admin: string;
  root: Uint8Array;
  datasetHash: Uint8Array;
  signTransaction: SignTxFn;
}) => invokePoolRoot({ ...opts, kind: "state" });

// ---------------------------------------------------------------------------
// Relayer market (Phase 6)
// ---------------------------------------------------------------------------

export async function invokeRelayerCreateJob(opts: {
  creator: string;
  jobId: Uint8Array;
  payloadHash: Uint8Array;
  deadlineLedger: number;
  fee: bigint;
  signTransaction: SignTxFn;
}): Promise<string> {
  return invokeContractMethod({
    sourcePublicKey: opts.creator,
    contractId: requireRelayerRegistryId(),
    method: "create_job",
    args: [
      nativeToScVal(opts.creator, { type: "address" }),
      bytesToScVal(opts.jobId),
      bytesToScVal(opts.payloadHash),
      nativeToScVal(opts.deadlineLedger, { type: "u32" }),
      nativeToScVal(opts.fee, { type: "i128" }),
    ],
    signTransaction: opts.signTransaction,
  });
}

export async function invokeRelayerCancelJob(opts: {
  creator: string;
  jobId: Uint8Array;
  signTransaction: SignTxFn;
}): Promise<string> {
  return invokeContractMethod({
    sourcePublicKey: opts.creator,
    contractId: requireRelayerRegistryId(),
    method: "cancel_job",
    args: [
      nativeToScVal(opts.creator, { type: "address" }),
      bytesToScVal(opts.jobId),
    ],
    signTransaction: opts.signTransaction,
  });
}

export async function invokeRelayerSlashJob(opts: {
  creator: string;
  jobId: Uint8Array;
  signTransaction: SignTxFn;
}): Promise<string> {
  return invokeContractMethod({
    sourcePublicKey: opts.creator,
    contractId: requireRelayerRegistryId(),
    method: "slash_job",
    args: [
      nativeToScVal(opts.creator, { type: "address" }),
      bytesToScVal(opts.jobId),
    ],
    signTransaction: opts.signTransaction,
  });
}

export { hexToBytes } from "./stealth";

export const SCHEMA_REGISTRY_PROGRAM_ID = SCHEMA_REGISTRY_CONTRACT_ID;
export const ATTESTATION_ENGINE_V2_PROGRAM_ID = ATTESTATION_ENGINE_V2_CONTRACT_ID;

export function hexPubkeyToBase58(hexOrAddr: string): string {
  return hexOrAddr.startsWith("G") ? hexOrAddr : hexOrAddr;
}

export async function fetchAllSchemas(): Promise<ParsedSchemaPDA[]> {
  return [];
}

export async function fetchAllAttestations(): Promise<unknown[]> {
  return [];
}

export async function fetchAttestationPDA(): Promise<string> {
  return "";
}

export interface ParsedSchemaPDA {
  schemaId: Uint8Array;
  authority: string;
  revocable: boolean;
  name: string;
  fieldDefinitions: string;
  deprecated: boolean;
}
