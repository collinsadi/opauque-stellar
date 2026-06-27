/**
 * Converts an on-chain attestation object into V2WitnessParams-compatible inputs.
 * Issue #417 — attestation-to-witness decoding library.
 */

import { stringToBigInt } from './fieldUtils';
import type { V2WitnessParams } from './types';

export interface AttestationInput {
  uid: string;
  schemaId: string;
  issuer: string;
  dataHex: string;
  stealthAddressHash: string;
  nonce: string;
}

export interface SchemaField {
  name: string;
  type: 'numeric' | 'string' | 'enum';
  enumValues?: string[];
}

const REQUIRED_ATTESTATION_FIELDS: Array<keyof AttestationInput> = [
  'uid',
  'schemaId',
  'issuer',
  'dataHex',
  'stealthAddressHash',
  'nonce',
];

/**
 * Result returned by `attestationToWitnessInputs`.
 * Omits `stealthPrivKeyBytes` and `externalNullifierStr` which the caller
 * must supply from wallet/session context.
 */
export interface WitnessInputResult
  extends Omit<V2WitnessParams, 'stealthPrivKeyBytes' | 'externalNullifierStr'> {
  /** Decoded schema field values as BigInt, keyed by field name. */
  decodedFields: Record<string, bigint>;
}

function validateHex(value: string, fieldName: string): void {
  const bare = value.replace(/^0x/i, '');
  if (bare.length === 0) return; // empty hex payload is allowed
  if (!/^[0-9a-fA-F]+$/.test(bare)) {
    throw new TypeError(
      `Invalid hex in attestation field "${fieldName}": "${value}"`,
    );
  }
  if (bare.length % 2 !== 0) {
    throw new TypeError(
      `Odd-length hex string in attestation field "${fieldName}": "${value}"`,
    );
  }
}

function decodeSchemaField(
  fieldName: string,
  rawDecimal: string,
  field: SchemaField,
): bigint {
  switch (field.type) {
    case 'numeric': {
      try {
        return BigInt(rawDecimal);
      } catch {
        throw new TypeError(
          `Cannot parse numeric field "${fieldName}" as BigInt: "${rawDecimal}"`,
        );
      }
    }

    case 'string': {
      // stringToBigInt interprets 0x-prefixed as hex; otherwise parses decimal.
      // For a string field stored as raw text bytes, we pass the decimal
      // representation of the packed byte value.
      return stringToBigInt(rawDecimal);
    }

    case 'enum': {
      const values = field.enumValues ?? [];
      // The raw decimal represents the numeric enum index stored on-chain.
      // Convert it back to the enum string, then look up the index.
      const numericIndex = Number(BigInt(rawDecimal));
      const enumString = values[numericIndex];
      if (enumString === undefined) {
        throw new TypeError(
          `Enum index ${numericIndex} out of bounds for field "${fieldName}". ` +
            `Valid values: [${values.map((v) => `"${v}"`).join(', ')}]`,
        );
      }
      const idx = values.indexOf(enumString);
      if (idx === -1) {
        throw new TypeError(
          `Enum value "${enumString}" not found in field "${fieldName}". ` +
            `Valid values: [${values.map((v) => `"${v}"`).join(', ')}]`,
        );
      }
      return BigInt(idx);
    }

    default: {
      const exhaustive: never = field.type;
      throw new TypeError(
        `Unknown field type "${exhaustive}" for field "${fieldName}"`,
      );
    }
  }
}

/**
 * Decodes `dataHex` bytes according to the schema.
 *
 * Each field is packed as a 32-byte big-endian unsigned integer (matching the
 * Soroban canonical layout used by `witnessV2.ts` for Poseidon hashing).
 */
function decodeDataHex(
  dataHex: string,
  schema: SchemaField[],
): Record<string, bigint> {
  const bare = dataHex.replace(/^0x/i, '');
  const dataBytes =
    bare.length > 0
      ? new Uint8Array(bare.length / 2)
      : new Uint8Array(0);

  for (let i = 0; i < bare.length; i += 2) {
    dataBytes[i / 2] = parseInt(bare.slice(i, i + 2), 16);
  }

  const decodedFields: Record<string, bigint> = {};
  for (let i = 0; i < schema.length; i++) {
    const field = schema[i];
    const start = i * 32;
    const end = start + 32;
    const chunk = dataBytes.slice(start, end);

    let chunkVal = 0n;
    for (const b of chunk) chunkVal = (chunkVal << 8n) | BigInt(b);

    decodedFields[field.name] = decodeSchemaField(
      field.name,
      chunkVal.toString(),
      field,
    );
  }

  return decodedFields;
}

/**
 * Converts an on-chain attestation record and schema definition into
 * witness inputs compatible with `buildV2Witness`.
 *
 * The caller must still supply `stealthPrivKeyBytes` and
 * `externalNullifierStr` from session/wallet context before calling
 * `buildV2Witness`.
 *
 * @throws {TypeError} If any required attestation field is missing, if
 *   `dataHex` is not valid hex, if an enum value is not found, or if an
 *   unknown field type is encountered.
 */
export function attestationToWitnessInputs(
  attestation: AttestationInput,
  schema: SchemaField[],
): WitnessInputResult {
  // Validate required attestation fields.
  for (const key of REQUIRED_ATTESTATION_FIELDS) {
    const val = attestation[key];
    if (val === undefined || val === null || (val as string) === '') {
      throw new TypeError(`Missing required attestation field: "${key}"`);
    }
  }

  // Validate dataHex before decoding.
  validateHex(attestation.dataHex, 'dataHex');

  const decodedFields = decodeDataHex(attestation.dataHex, schema);

  return {
    schemaIdField: attestation.schemaId,
    issuerPkX: attestation.issuer,
    nonceField: attestation.nonce,
    traitDataHex: attestation.dataHex,
    decodedFields,
  };
}
