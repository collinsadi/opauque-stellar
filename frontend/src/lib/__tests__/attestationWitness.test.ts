import { describe, expect, it } from "vitest";
import {
  AttestationDataError,
  WitnessConversionError,
  attestationToWitnessInputs,
} from "../attestationWitness";
import {
  encodeAttestationData,
  parseFieldDefinitions,
} from "../schemaEncoding";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Encode field values to hex using the canonical schema encoder. */
function encodeHex(defs: string, values: Record<string, string>): string {
  const fields = parseFieldDefinitions(defs);
  const bytes = encodeAttestationData(values, fields);
  return "0x" + Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Pack first `n` bytes of a Uint8Array as a big-endian bigint. */
function packBigEndian(bytes: Uint8Array, n: number): bigint {
  const slice = bytes.slice(0, n);
  let result = 0n;
  for (const b of slice) result = (result << 8n) | BigInt(b);
  return result;
}

// ---------------------------------------------------------------------------
// bool field
// ---------------------------------------------------------------------------

describe("attestationToWitnessInputs — bool", () => {
  it("bool true field decodes to fieldBigInt 1n", () => {
    const hex = encodeHex("bool active", { active: "true" });
    const fields = parseFieldDefinitions("bool active");
    const result = attestationToWitnessInputs(hex, fields);
    expect(result).toHaveLength(1);
    expect(result[0].fieldBigInt).toBe(1n);
    expect(result[0].rawValue).toBe("true");
    expect(result[0].type).toBe("bool");
  });

  it("bool false field decodes to fieldBigInt 0n", () => {
    const hex = encodeHex("bool active", { active: "false" });
    const fields = parseFieldDefinitions("bool active");
    const result = attestationToWitnessInputs(hex, fields);
    expect(result[0].fieldBigInt).toBe(0n);
    expect(result[0].rawValue).toBe("false");
  });
});

// ---------------------------------------------------------------------------
// Numeric fields
// ---------------------------------------------------------------------------

describe("attestationToWitnessInputs — u8", () => {
  it("u8 field with value 42 decodes to 42n", () => {
    const hex = encodeHex("u8 score", { score: "42" });
    const fields = parseFieldDefinitions("u8 score");
    const result = attestationToWitnessInputs(hex, fields);
    expect(result[0].fieldBigInt).toBe(42n);
    expect(result[0].rawValue).toBe("42");
  });
});

describe("attestationToWitnessInputs — u32", () => {
  it("u32 field decodes correctly", () => {
    const hex = encodeHex("u32 counter", { counter: "1000000" });
    const fields = parseFieldDefinitions("u32 counter");
    const result = attestationToWitnessInputs(hex, fields);
    expect(result[0].fieldBigInt).toBe(1000000n);
    expect(result[0].type).toBe("u32");
  });

  it("u32 max value decodes correctly", () => {
    const hex = encodeHex("u32 v", { v: "4294967295" });
    const fields = parseFieldDefinitions("u32 v");
    const result = attestationToWitnessInputs(hex, fields);
    expect(result[0].fieldBigInt).toBe(4294967295n);
  });
});

describe("attestationToWitnessInputs — u64", () => {
  it("u64 field decodes correctly", () => {
    const value = "9007199254740993"; // > Number.MAX_SAFE_INTEGER
    const hex = encodeHex("u64 amount", { amount: value });
    const fields = parseFieldDefinitions("u64 amount");
    const result = attestationToWitnessInputs(hex, fields);
    expect(result[0].fieldBigInt).toBe(BigInt(value));
    expect(result[0].type).toBe("u64");
  });
});

// ---------------------------------------------------------------------------
// string field
// ---------------------------------------------------------------------------

describe("attestationToWitnessInputs — string", () => {
  it("string field encodes as packed bytes bigint (first 31 bytes)", () => {
    const str = "hello";
    const hex = encodeHex("string label", { label: str });
    const fields = parseFieldDefinitions("string label");
    const result = attestationToWitnessInputs(hex, fields);

    const expectedBytes = new TextEncoder().encode(str);
    const expected = packBigEndian(expectedBytes, 31);
    expect(result[0].fieldBigInt).toBe(expected);
    expect(result[0].rawValue).toBe(str);
  });

  it("longer string still uses only first 31 bytes for bigint", () => {
    const str = "A".repeat(50);
    const hex = encodeHex("string label", { label: str });
    const fields = parseFieldDefinitions("string label");
    const result = attestationToWitnessInputs(hex, fields);

    const expectedBytes = new TextEncoder().encode(str);
    const expected = packBigEndian(expectedBytes, 31);
    expect(result[0].fieldBigInt).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// pubkey field
// ---------------------------------------------------------------------------

describe("attestationToWitnessInputs — pubkey", () => {
  it("pubkey field converts 0x-prefixed hex to bigint (first 31 bytes)", () => {
    const pk = "0x" + "ab".repeat(32); // 32 bytes = 64 hex chars
    const hex = encodeHex("pubkey owner", { owner: pk });
    const fields = parseFieldDefinitions("pubkey owner");
    const result = attestationToWitnessInputs(hex, fields);

    // First 31 bytes of 0xabab...ab
    const pkBytes = new Uint8Array(32).fill(0xab);
    const expected = packBigEndian(pkBytes, 31);
    expect(result[0].fieldBigInt).toBe(expected);
    expect(result[0].rawValue).toBe(pk);
  });
});

// ---------------------------------------------------------------------------
// Multi-field round-trip
// ---------------------------------------------------------------------------

describe("attestationToWitnessInputs — multi-field", () => {
  it("decodes all field types correctly in one attestation", () => {
    const defs = "bool active,u8 score,u32 counter,string label";
    const values = {
      active: "true",
      score: "7",
      counter: "42",
      label: "test",
    };
    const hex = encodeHex(defs, values);
    const fields = parseFieldDefinitions(defs);
    const result = attestationToWitnessInputs(hex, fields);

    expect(result).toHaveLength(4);
    expect(result[0].fieldBigInt).toBe(1n);  // bool true
    expect(result[1].fieldBigInt).toBe(7n);   // u8
    expect(result[2].fieldBigInt).toBe(42n);  // u32
    // string "test"
    const testBytes = new TextEncoder().encode("test");
    expect(result[3].fieldBigInt).toBe(packBigEndian(testBytes, 31));
  });
});

// ---------------------------------------------------------------------------
// Error cases
// ---------------------------------------------------------------------------

describe("attestationToWitnessInputs — errors", () => {
  it("throws WitnessConversionError for invalid hex input", () => {
    const fields = parseFieldDefinitions("bool active");
    expect(() =>
      attestationToWitnessInputs("not-hex-at-all!", fields),
    ).toThrow(WitnessConversionError);
  });

  it("throws WitnessConversionError for odd-length hex (not bare bytes)", () => {
    const fields = parseFieldDefinitions("bool active");
    expect(() =>
      attestationToWitnessInputs("0x0", fields), // odd length after stripping
    ).toThrow(WitnessConversionError);
  });

  it("throws AttestationDataError for truncated data (missing field)", () => {
    // Encode only 1 byte for a bool, but schema expects u32 (4 bytes)
    const fields = parseFieldDefinitions("u32 counter");
    // Only 1 byte — too short for a u32
    expect(() =>
      attestationToWitnessInputs("0x01", fields),
    ).toThrow(AttestationDataError);
  });

  it("re-throws AttestationDataError as-is (not wrapped)", () => {
    const fields = parseFieldDefinitions("u64 amount");
    // 4 bytes — too short for u64 (needs 8)
    try {
      attestationToWitnessInputs("0x01020304", fields);
      expect.fail("Expected AttestationDataError");
    } catch (err) {
      expect(err).toBeInstanceOf(AttestationDataError);
      // Must NOT be a WitnessConversionError
      expect(err).not.toBeInstanceOf(WitnessConversionError);
    }
  });

  it("treats bool as enum-like: only 0/1 values (true maps to 1n, false to 0n)", () => {
    // bool is the closest type to an enum: it has exactly two states.
    const trueHex = encodeHex("bool flag", { flag: "true" });
    const falseHex = encodeHex("bool flag", { flag: "false" });
    const fields = parseFieldDefinitions("bool flag");

    const r1 = attestationToWitnessInputs(trueHex, fields);
    const r2 = attestationToWitnessInputs(falseHex, fields);
    expect(r1[0].fieldBigInt).toBe(1n);
    expect(r2[0].fieldBigInt).toBe(0n);
    // Both are clearly distinct — enforced enum-like semantics
    expect(r1[0].fieldBigInt).not.toBe(r2[0].fieldBigInt);
  });
});
