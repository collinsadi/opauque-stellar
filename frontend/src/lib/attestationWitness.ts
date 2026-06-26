/**
 * Attestation-to-witness decoding library.
 *
 * Provides a single entry point used by all proof modals to convert a raw
 * on-chain attestation hex payload into the BN254-safe bigint witness inputs
 * required by the Groth16 circuits.
 *
 * Field types supported: bool | u8 | u16 | u32 | u64 | string | pubkey
 * (matches FieldType from schema.ts — there is no "enum" type).
 */

import { AttestationDataError, decodeAttestationData } from "./schemaEncoding";
import type { FieldDef } from "./schema";

export { AttestationDataError };

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class WitnessConversionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WitnessConversionError";
  }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface WitnessFieldValue {
  /** Field name from the schema. */
  name: string;
  /** Field type string (e.g. "bool", "u8", "string", "pubkey"). */
  type: string;
  /** Decoded string value (as returned by decodeAttestationData). */
  rawValue: string;
  /**
   * BN254-safe bigint representation used in circuits.
   *
   * Derivation rules:
   *   bool   → 1n (true) | 0n (false)
   *   u8/u16/u32/u64 → BigInt(value)
   *   string → UTF-8 bytes packed as big-endian bigint (first 31-byte chunk)
   *   pubkey → first 31 bytes of the 32-byte key as big-endian bigint
   */
  fieldBigInt: bigint;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Pack the first `limit` bytes of `bytes` into a big-endian bigint. */
function packBigEndian(bytes: Uint8Array, limit: number): bigint {
  const slice = bytes.slice(0, limit);
  let n = 0n;
  for (const b of slice) {
    n = (n << 8n) | BigInt(b);
  }
  return n;
}

/** Convert a decoded field value to its circuit bigint representation. */
function valueToFieldBigInt(type: string, rawValue: string): bigint {
  switch (type) {
    case "bool":
      return rawValue === "true" ? 1n : 0n;

    case "u8":
    case "u16":
    case "u32":
    case "u64":
      return BigInt(rawValue);

    case "string": {
      const bytes = new TextEncoder().encode(rawValue);
      // Pack first 31 bytes as big-endian — matches witnessV2 chunk logic.
      return packBigEndian(bytes, 31);
    }

    case "pubkey": {
      // Decode 0x-prefixed 32-byte hex key; use first 31 bytes.
      const hex = rawValue.replace(/^0x/i, "");
      const bytes = new Uint8Array(32);
      for (let i = 0; i < 32; i++) {
        bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      }
      return packBigEndian(bytes, 31);
    }

    default:
      throw new WitnessConversionError(`Unsupported field type: ${type}`);
  }
}

/** Return true if `hex` (stripped of optional 0x prefix) is valid hex. */
function isHex(s: string): boolean {
  return /^[0-9a-fA-F]*$/.test(s) && s.length % 2 === 0;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Decode a raw attestation hex payload and convert each field to a
 * BN254-safe witness bigint.
 *
 * @param attestationHex  0x-prefixed or bare hex string of the on-chain payload.
 * @param fieldDefs       Schema field definitions (in encoding order).
 * @returns Array of `WitnessFieldValue` in schema field order.
 *
 * @throws {WitnessConversionError} if `attestationHex` is not valid hex.
 * @throws {AttestationDataError} if the bytes don't match the schema
 *   (propagated as-is from `decodeAttestationData`).
 */
export function attestationToWitnessInputs(
  attestationHex: string,
  fieldDefs: FieldDef[],
): WitnessFieldValue[] {
  // Validate and decode hex → bytes
  const bare = attestationHex.replace(/^0x/i, "");
  if (!isHex(bare)) {
    throw new WitnessConversionError(
      `Invalid attestation hex: "${attestationHex}" is not valid hexadecimal`,
    );
  }

  const bytes = new Uint8Array(bare.length / 2);
  for (let i = 0; i < bare.length; i += 2) {
    bytes[i / 2] = parseInt(bare.slice(i, i + 2), 16);
  }

  // May throw AttestationDataError — re-raised as-is per spec.
  const decoded = decodeAttestationData(bytes, fieldDefs);

  return fieldDefs.map((field): WitnessFieldValue => {
    const rawValue = decoded[field.name] ?? "";
    const fieldBigInt = valueToFieldBigInt(field.type, rawValue);
    return {
      name: field.name,
      type: field.type,
      rawValue,
      fieldBigInt,
    };
  });
}
