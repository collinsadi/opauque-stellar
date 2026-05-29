/**
 * Soroban contract invocation helpers for Schema Registry, Attestation Engine, Groth16.
 */

import { nativeToScVal, StrKey } from "@stellar/stellar-sdk";
import { deployedAddresses } from "../contracts/deployedAddresses";
import { bytesToScVal, invokeContractMethod } from "./stellar";
import type { SignTxFn } from "./stellar";

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

/** @deprecated */
export function buildRegisterSchemaInstruction(): never {
  throw new Error("Use invokeRegisterSchema() on Stellar");
}

/** @deprecated */
export function buildAttestInstruction(): never {
  throw new Error("Use invokeAttest() on Stellar");
}

/** @deprecated */
export function buildVerifyProofV2Instruction(): never {
  throw new Error("Use invokeVerifyProofV2() on Stellar");
}

/** @deprecated use announceStealthTransfer from contracts */
export { buildAnnounceInstruction } from "./contracts";

/** @deprecated Soroban schema management not yet wired in the UI */
export function buildDeprecateSchemaInstruction(): never {
  throw new Error("Schema deprecation on Stellar is not yet implemented in the UI");
}

/** @deprecated */
export function buildAddDelegateInstruction(): never {
  throw new Error("Delegate management on Stellar is not yet implemented in the UI");
}

/** @deprecated */
export function buildRemoveDelegateInstruction(): never {
  throw new Error("Delegate management on Stellar is not yet implemented in the UI");
}

/** @deprecated */
export function buildRevokeInstruction(): never {
  throw new Error("Attestation revocation on Stellar is not yet implemented in the UI");
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
