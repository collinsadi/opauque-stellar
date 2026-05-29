/**
 * Attestation Engine V2 — client-side interaction layer
 */

import { z } from "zod";
import { ATTESTATION_ENGINE_V2_CONTRACT_ID } from "./schema";
import {
  decodeAttestationData as decodeCanonicalAttestationData,
  encodeAttestationData as encodeCanonicalAttestationData,
} from "./schemaEncoding";
import type { FieldDef } from "./schema";

/** @deprecated */
export const ATTESTATION_ENGINE_V2_PROGRAM_ID = ATTESTATION_ENGINE_V2_CONTRACT_ID;

export interface AttestationV2 {
  address: string;
  uid: string;
  schemaPda: string;
  schemaId: string;
  issuer: string;
  stealthAddressHash: string;
  dataHex: string;
  createdAt: number;
  expirationSlot: number;
  revocationSlot: number;
  refUid: string;
  issuanceSequence?: number;
  isValid: boolean;
}

export interface AttestationFormData {
  schemaId: string;
  schemaPda: string;
  stealthAddressHash: string;
  fieldValues: Record<string, string>;
  expirationSlot: number;
  refUid: string;
}

export async function deriveAttestationPDA(
  schemaId: Uint8Array,
  issuer: string,
  stealthAddressHash: Uint8Array,
): Promise<[string, number]> {
  const id = Array.from(schemaId)
    .concat(Array.from(stealthAddressHash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return [`${issuer}:${id.slice(0, 64)}`, 0];
}

/** Encodes field values in canonical schema order (typed binary layout). */
export function encodeAttestationData(
  fieldValues: Record<string, string>,
  fieldDefs: FieldDef[] | { name: string; type: string }[],
): Uint8Array {
  const defs: FieldDef[] = fieldDefs.map((f, i) => ({
    id: "id" in f ? f.id : String(i),
    name: f.name,
    type: f.type as FieldDef["type"],
  }));
  return encodeCanonicalAttestationData(fieldValues, defs);
}

/** Decodes canonical attestation bytes using schema field definitions. */
export function decodeAttestationData(
  dataHex: string,
  fieldDefs: FieldDef[] | { name: string; type: string }[],
): Record<string, string> {
  const defs: FieldDef[] = fieldDefs.map((f, i) => ({
    id: "id" in f ? f.id : String(i),
    name: f.name,
    type: f.type as FieldDef["type"],
  }));
  return decodeCanonicalAttestationData(hexToBytes(dataHex), defs);
}

export const AttestationV2Schema = z.object({
  address: z.string(),
  uid: z.string(),
  schemaPda: z.string(),
  schemaId: z.string(),
  issuer: z.string(),
  stealthAddressHash: z.string(),
  dataHex: z.string(),
  createdAt: z.number(),
  expirationSlot: z.number(),
  revocationSlot: z.number(),
  refUid: z.string(),
  issuanceSequence: z.number().optional(),
  isValid: z.boolean(),
});

export const AttestationV2ArraySchema = z.array(AttestationV2Schema);

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "");
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    bytes[i / 2] = parseInt(clean.slice(i, i + 2), 16);
  }
  return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
  return "0x" + Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function isZeroUid(uid: string): boolean {
  return uid.replace(/^0x/, "").replace(/0/g, "") === "";
}

export function formatSlotDistance(slot: number, currentSlot: number): string {
  if (slot === 0) return "Never";
  const diff = slot - currentSlot;
  if (diff <= 0) return "Expired";
  const seconds = diff * 0.4;
  if (seconds < 60) return `~${Math.round(seconds)}s`;
  if (seconds < 3600) return `~${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `~${Math.round(seconds / 3600)}h`;
  return `~${Math.round(seconds / 86400)}d`;
}
