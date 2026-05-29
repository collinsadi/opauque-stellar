/**
 * Canonical schema / attestation encoding — mirrors `opaque-schema-core` and Soroban contracts.
 */

import { StrKey } from "@stellar/stellar-sdk";
import type { FieldDef, FieldType } from "./schema";

export const MAX_FIELDS = 16;
export const MAX_FIELD_NAME_LEN = 32;
export const MAX_STRING_VALUE_LEN = 128;
export const MAX_ATTESTATION_DATA_LEN = 512;

const FIELD_TYPE_IDS: Record<FieldType, number> = {
  bool: 0,
  u8: 1,
  u16: 2,
  u32: 3,
  u64: 4,
  string: 5,
  pubkey: 6,
};

export class SchemaParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaParseError";
  }
}

export class AttestationDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttestationDataError";
  }
}

function isValidFieldName(name: string): boolean {
  if (!name || name.length > MAX_FIELD_NAME_LEN) return false;
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) return false;
  return true;
}

/** Parses and validates `"type name"` comma-separated field definitions. */
export function parseFieldDefinitions(fieldDefs: string): FieldDef[] {
  const trimmed = fieldDefs.trim();
  if (!trimmed) {
    throw new SchemaParseError("Field definitions cannot be empty");
  }
  const fields: FieldDef[] = [];
  for (const segment of trimmed.split(",")) {
    const seg = segment.trim();
    if (!seg) throw new SchemaParseError("Malformed field segment");
    const spaceIdx = seg.indexOf(" ");
    if (spaceIdx === -1) {
      throw new SchemaParseError(
        'Expected "type name" format (legacy "name:type" is not supported)',
      );
    }
    const type = seg.slice(0, spaceIdx).trim() as FieldType;
    const name = seg.slice(spaceIdx + 1).trim();
    if (name.includes(" ") || !Object.hasOwn(FIELD_TYPE_IDS, type)) {
      throw new SchemaParseError(`Invalid field type: ${type}`);
    }
    if (!isValidFieldName(name)) {
      throw new SchemaParseError(`Invalid field name: ${name}`);
    }
    if (fields.some((f) => f.name === name)) {
      throw new SchemaParseError(`Duplicate field name: ${name}`);
    }
    fields.push({ id: String(fields.length), name, type });
    if (fields.length > MAX_FIELDS) {
      throw new SchemaParseError("Too many fields");
    }
  }
  const canonical = fieldDefsToCanonicalString(fields);
  if (canonical.length > 256) {
    throw new SchemaParseError("Field definitions too long");
  }
  return fields;
}

export function fieldDefsToCanonicalString(fields: FieldDef[]): string {
  return fields
    .filter((f) => f.name.trim())
    .map((f) => `${f.type} ${f.name.trim()}`)
    .join(",");
}

export function encodeCanonicalFieldDefs(fields: FieldDef[]): Uint8Array {
  const parts: number[] = [fields.length];
  for (const f of fields) {
    const nameBytes = new TextEncoder().encode(f.name);
    parts.push(FIELD_TYPE_IDS[f.type], nameBytes.length, ...nameBytes);
  }
  return new Uint8Array(parts);
}

export function addressToAuthorityBytes(address: string): Uint8Array {
  return Uint8Array.from(StrKey.decodeEd25519PublicKey(address));
}

export async function computeSchemaIdFromBytes(
  authorityBytes: Uint8Array,
  name: string,
  fieldDefinitions: string,
  version: number = 1,
): Promise<Uint8Array> {
  const fields = parseFieldDefinitions(fieldDefinitions);
  const canonical = encodeCanonicalFieldDefs(fields);
  const encoder = new TextEncoder();
  const nameBytes = encoder.encode(name);
  const versionBytes = new Uint8Array(4);
  new DataView(versionBytes.buffer).setUint32(0, version, false);
  const combined = new Uint8Array(
    authorityBytes.length +
      nameBytes.length +
      versionBytes.length +
      canonical.length,
  );
  let off = 0;
  combined.set(authorityBytes, off);
  off += authorityBytes.length;
  combined.set(nameBytes, off);
  off += nameBytes.length;
  combined.set(versionBytes, off);
  off += versionBytes.length;
  combined.set(canonical, off);
  const hashBuffer = await crypto.subtle.digest("SHA-256", combined);
  return new Uint8Array(hashBuffer);
}

export async function computeSchemaId(
  authority: string,
  name: string,
  fieldDefinitions: string,
  version: number = 1,
): Promise<Uint8Array> {
  return computeSchemaIdFromBytes(
    addressToAuthorityBytes(authority),
    name,
    fieldDefinitions,
    version,
  );
}

function parseBool(value: string): boolean {
  const v = value.trim();
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0" || v === "") return false;
  throw new AttestationDataError(`Invalid bool: ${value}`);
}

function parseUint(value: string, max: bigint): bigint {
  const v = value.trim();
  if (!v) return 0n;
  if (!/^\d+$/.test(v)) throw new AttestationDataError(`Invalid integer: ${value}`);
  const n = BigInt(v);
  if (n < 0n || n > max) throw new AttestationDataError(`Integer out of range: ${value}`);
  return n;
}

function parsePubkeyHex(value: string): Uint8Array {
  const hex = value.trim().replace(/^0x/i, "");
  if (hex.length !== 64) throw new AttestationDataError("Invalid pubkey hex");
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Encodes attestation payload bytes in schema field order. */
export function encodeAttestationData(
  fieldValues: Record<string, string>,
  fieldDefs: FieldDef[],
): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const field of fieldDefs) {
    const value = fieldValues[field.name] ?? "";
    switch (field.type) {
      case "bool": {
        const b = parseBool(value);
        parts.push(new Uint8Array([b ? 1 : 0]));
        break;
      }
      case "u8":
        parts.push(new Uint8Array([Number(parseUint(value, 255n))]));
        break;
      case "u16": {
        const buf = new Uint8Array(2);
        new DataView(buf.buffer).setUint16(0, Number(parseUint(value, 65535n)), false);
        parts.push(buf);
        break;
      }
      case "u32": {
        const buf = new Uint8Array(4);
        new DataView(buf.buffer).setUint32(0, Number(parseUint(value, 4294967295n)), false);
        parts.push(buf);
        break;
      }
      case "u64": {
        const buf = new Uint8Array(8);
        new DataView(buf.buffer).setBigUint64(0, parseUint(value, 18446744073709551615n), false);
        parts.push(buf);
        break;
      }
      case "string": {
        const bytes = new TextEncoder().encode(value);
        if (bytes.length > MAX_STRING_VALUE_LEN) {
          throw new AttestationDataError("String value too long");
        }
        const len = new Uint8Array(2);
        new DataView(len.buffer).setUint16(0, bytes.length, false);
        parts.push(len, bytes);
        break;
      }
      case "pubkey":
        parts.push(parsePubkeyHex(value));
        break;
      default:
        throw new AttestationDataError(`Unsupported type: ${field.type}`);
    }
  }
  const total = parts.reduce((a, p) => a + p.length, 0);
  if (total > MAX_ATTESTATION_DATA_LEN) {
    throw new AttestationDataError("Attestation data too large");
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** Decodes canonical attestation bytes into a field-value map. */
export function decodeAttestationData(
  data: Uint8Array,
  fieldDefs: FieldDef[],
): Record<string, string> {
  const dec = new TextDecoder();
  const result: Record<string, string> = {};
  let offset = 0;

  for (const field of fieldDefs) {
    switch (field.type) {
      case "bool": {
        if (offset >= data.length) throw new AttestationDataError("Truncated bool");
        result[field.name] = data[offset] === 1 ? "true" : "false";
        offset += 1;
        break;
      }
      case "u8":
        if (offset >= data.length) throw new AttestationDataError("Truncated u8");
        result[field.name] = String(data[offset]);
        offset += 1;
        break;
      case "u16": {
        if (offset + 2 > data.length) throw new AttestationDataError("Truncated u16");
        result[field.name] = String(new DataView(data.buffer, data.byteOffset + offset, 2).getUint16(0, false));
        offset += 2;
        break;
      }
      case "u32": {
        if (offset + 4 > data.length) throw new AttestationDataError("Truncated u32");
        result[field.name] = String(new DataView(data.buffer, data.byteOffset + offset, 4).getUint32(0, false));
        offset += 4;
        break;
      }
      case "u64": {
        if (offset + 8 > data.length) throw new AttestationDataError("Truncated u64");
        result[field.name] = String(
          new DataView(data.buffer, data.byteOffset + offset, 8).getBigUint64(0, false),
        );
        offset += 8;
        break;
      }
      case "string": {
        if (offset + 2 > data.length) throw new AttestationDataError("Truncated string length");
        const len = new DataView(data.buffer, data.byteOffset + offset, 2).getUint16(0, false);
        offset += 2;
        if (offset + len > data.length) throw new AttestationDataError("Truncated string");
        result[field.name] = dec.decode(data.slice(offset, offset + len));
        offset += len;
        break;
      }
      case "pubkey": {
        if (offset + 32 > data.length) throw new AttestationDataError("Truncated pubkey");
        const slice = data.slice(offset, offset + 32);
        result[field.name] =
          "0x" + Array.from(slice).map((b) => b.toString(16).padStart(2, "0")).join("");
        offset += 32;
        break;
      }
      default:
        throw new AttestationDataError(`Unsupported type: ${field.type}`);
    }
  }
  if (offset !== data.length) {
    throw new AttestationDataError("Trailing bytes in attestation data");
  }
  return result;
}
