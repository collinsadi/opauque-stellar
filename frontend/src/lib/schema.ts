/**
 * Schema Registry — V2 Stealth Reputation Protocol (Stellar Soroban).
 */

import { deployedAddresses } from "../contracts/deployedAddresses";
import {
  computeSchemaId,
  fieldDefsToCanonicalString,
  parseFieldDefinitions,
} from "./schemaEncoding";

export {
  computeSchemaId,
  computeSchemaIdFromBytes,
  encodeCanonicalFieldDefs,
  fieldDefsToCanonicalString,
  parseFieldDefinitions,
  SchemaParseError,
} from "./schemaEncoding";

export const SCHEMA_REGISTRY_CONTRACT_ID = deployedAddresses.schemaRegistry;
export const ATTESTATION_ENGINE_V2_CONTRACT_ID =
  deployedAddresses.attestationEngineV2;
/** @deprecated Old-era name; use SCHEMA_REGISTRY_CONTRACT_ID */
export const SCHEMA_REGISTRY_PROGRAM_ID = SCHEMA_REGISTRY_CONTRACT_ID;

export type FieldType =
  | "bool"
  | "u8"
  | "u16"
  | "u32"
  | "u64"
  | "string"
  | "pubkey";

export interface FieldDef {
  id: string;
  name: string;
  type: FieldType;
}

export interface SchemaV2 {
  address: string;
  schemaId: string;
  authority: string;
  resolver: string;
  revocable: boolean;
  name: string;
  fieldDefinitions: string;
  version: number;
  delegates: string[];
  createdAt: number;
  schemaExpiryLedger: number;
  /** @deprecated alias */
  schemaExpirySlot: number;
  deprecated: boolean;
}

/** @deprecated Use parseFieldDefinitions from schemaEncoding */
export function parseFieldDefs(fieldDefs: string): FieldDef[] {
  return parseFieldDefinitions(fieldDefs);
}

export function fieldDefsToString(fields: FieldDef[]): string {
  return fieldDefsToCanonicalString(fields);
}

/** Estimated XLM reserve hint for schema registration UI */
export const SCHEMA_RENT_STROOPS = 10_000_000n;

export async function prepareRegisterSchema(
  authority: string,
  name: string,
  fieldDefinitions: string,
  version: number = 1,
): Promise<{ schemaId: Uint8Array; schemaKey: string; canonicalFieldDefs: string }> {
  const canonicalFieldDefs = fieldDefsToCanonicalString(
    parseFieldDefinitions(fieldDefinitions),
  );
  const schemaId = await computeSchemaId(authority, name, fieldDefinitions, version);
  const schemaKey = `${authority}:${Array.from(schemaId)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;
  return { schemaId, schemaKey, canonicalFieldDefs };
}

export function packSchemaIdToField(schemaId: Uint8Array): string {
  return (
    "0x" +
    Array.from(schemaId)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  );
}
