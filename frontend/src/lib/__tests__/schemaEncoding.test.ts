import { describe, expect, it } from "vitest";
import {
  computeSchemaIdFromBytes,
  decodeAttestationData,
  encodeAttestationData,
  fieldDefsToCanonicalString,
  parseFieldDefinitions,
  SchemaParseError,
} from "../schemaEncoding";

const TEST_AUTHORITY_BYTES = new Uint8Array(32).fill(0x2a);

/** Shared with `opaque-schema-core` / `schema-registry` tests. */
const VECTOR_1_SCHEMA_ID =
  "9dfa94834360623aa1fdc98ac048339004cf326bb1b49d853e15dc063f6c2547";

describe("parseFieldDefinitions", () => {
  it("parses type-first segments", () => {
    const fields = parseFieldDefinitions("bool active, string label");
    expect(fields).toHaveLength(2);
    expect(fieldDefsToCanonicalString(fields)).toBe("bool active,string label");
  });

  it("rejects legacy name:type", () => {
    expect(() => parseFieldDefinitions("field1:string")).toThrow(SchemaParseError);
  });

  it("rejects invalid types", () => {
    expect(() => parseFieldDefinitions("float x")).toThrow(SchemaParseError);
  });
});

describe("computeSchemaIdFromBytes", () => {
  it("matches Rust test vector 1", async () => {
    const id = await computeSchemaIdFromBytes(
      TEST_AUTHORITY_BYTES,
      "MySchema",
      "string name",
      1,
    );
    const hex = Array.from(id)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    expect(hex).toBe(VECTOR_1_SCHEMA_ID);
  });

  it("differs when field definitions change", async () => {
    const a = await computeSchemaIdFromBytes(
      TEST_AUTHORITY_BYTES,
      "MySchema",
      "string name",
      1,
    );
    const b = await computeSchemaIdFromBytes(
      TEST_AUTHORITY_BYTES,
      "MySchema",
      "u32 name",
      1,
    );
    expect(a).not.toEqual(b);
  });

  it("uses 4-byte big-endian version", async () => {
    const v1 = await computeSchemaIdFromBytes(
      TEST_AUTHORITY_BYTES,
      "MySchema",
      "string x",
      1,
    );
    const v2 = await computeSchemaIdFromBytes(
      TEST_AUTHORITY_BYTES,
      "MySchema",
      "string x",
      2,
    );
    expect(v1).not.toEqual(v2);
  });
});

describe("attestation data round-trip", () => {
  const defs = "bool b,u8 n,u16 w,u32 x,u64 y,string s,pubkey p";
  const fields = parseFieldDefinitions(defs);
  const pk = "0x" + "2a".repeat(32);
  const values: Record<string, string> = {
    b: "true",
    n: "42",
    w: "1000",
    x: "99999",
    y: "100",
    s: "hello",
    p: pk,
  };

  it("encodes and decodes all supported types", () => {
    const encoded = encodeAttestationData(values, fields);
    expect(encoded.length).toBeLessThanOrEqual(512);
    const decoded = decodeAttestationData(encoded, fields);
    expect(decoded.b).toBe("true");
    expect(decoded.n).toBe("42");
    expect(decoded.s).toBe("hello");
    expect(decoded.p).toBe(pk);
  });
});
