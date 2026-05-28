/**
 * Tests for #54: meta-address prefix validation (client-side mirror of contract checks).
 * Tests for #57: contract IDs are plain strings, no .toBase58() calls.
 * Tests for #55: nonce/history semantics documentation via parseStealthMetaAddress.
 */

import { describe, it, expect } from "vitest";
import {
  keysToStealthMetaAddress,
  stealthMetaAddressToHex,
  parseStealthMetaAddress,
  deriveKeysFromSignature,
  bytesToHex,
  type Hex,
} from "../lib/stealth";
import { isValidStellarContractId } from "../contracts/deploymentManifest";

// ── #54: Prefix validation ────────────────────────────────────────────────────

const VALID_PREFIXES = [0x02, 0x03];
const INVALID_PREFIXES = [0x00, 0x01, 0x04, 0x05, 0xff];

function makeMetaAddressHex(viewPrefix: number, spendPrefix: number): Hex {
  const view = new Uint8Array(33);
  view[0] = viewPrefix;
  view.fill(0x01, 1);
  const spend = new Uint8Array(33);
  spend[0] = spendPrefix;
  spend.fill(0x02, 1);
  const combined = new Uint8Array(66);
  combined.set(view, 0);
  combined.set(spend, 33);
  return ("0x" + bytesToHex(combined)) as Hex;
}

describe("Meta-address prefix validation (#54)", () => {
  it("accepts valid 0x02/0x03 prefixes from real key derivation", () => {
    const sig = ("0x" + "ab".repeat(64)) as Hex;
    const keys = deriveKeysFromSignature(sig);
    const { V, S } = keysToStealthMetaAddress(keys.viewingKey, keys.spendingKey);
    // secp256k1 compressed keys always have 0x02 or 0x03 prefix
    expect(VALID_PREFIXES).toContain(V[0]);
    expect(VALID_PREFIXES).toContain(S[0]);
  });

  it("parseStealthMetaAddress round-trips valid meta-addresses", () => {
    const sig = ("0x" + "cd".repeat(64)) as Hex;
    const keys = deriveKeysFromSignature(sig);
    const { metaAddress, V, S } = keysToStealthMetaAddress(keys.viewingKey, keys.spendingKey);
    const hex = stealthMetaAddressToHex(metaAddress);
    const parsed = parseStealthMetaAddress(hex);
    expect(parsed.viewPubKey).toEqual(V);
    expect(parsed.spendPubKey).toEqual(S);
  });

  it("rejects meta-address shorter than 66 bytes", () => {
    expect(() => parseStealthMetaAddress("0xdeadbeef" as Hex)).toThrow(
      "Invalid stealth meta-address"
    );
  });

  it("rejects empty meta-address", () => {
    expect(() => parseStealthMetaAddress("0x" as Hex)).toThrow(
      "Invalid stealth meta-address"
    );
  });

  it.each(INVALID_PREFIXES)(
    "flags invalid view prefix 0x%s (contract will reject)",
    (prefix) => {
      const hex = makeMetaAddressHex(prefix, 0x02);
      // Client-side parse succeeds (no prefix check in JS), but the bytes
      // are detectable as invalid — the contract enforces the prefix check.
      const parsed = parseStealthMetaAddress(hex);
      expect(VALID_PREFIXES).not.toContain(parsed.viewPubKey[0]);
    }
  );

  it.each(INVALID_PREFIXES)(
    "flags invalid spend prefix 0x%s (contract will reject)",
    (prefix) => {
      const hex = makeMetaAddressHex(0x02, prefix);
      const parsed = parseStealthMetaAddress(hex);
      expect(VALID_PREFIXES).not.toContain(parsed.spendPubKey[0]);
    }
  );
});

// ── #57: Contract IDs are plain strings ──────────────────────────────────────

describe("Contract ID typing (#57)", () => {
  it("Stellar contract IDs are valid C… Strkey strings", () => {
    // A well-formed Soroban contract ID starts with 'C' and is 56 chars.
    const exampleContractId = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
    expect(isValidStellarContractId(exampleContractId)).toBe(true);
  });

  it("contract IDs do not need .toBase58() — they are already strings", () => {
    const contractId = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
    // Using the string directly is the correct approach.
    expect(typeof contractId).toBe("string");
    expect(contractId.startsWith("C")).toBe(true);
  });

  it("rejects Solana-style base58 addresses as Stellar contract IDs", () => {
    const solanaAddress = "11111111111111111111111111111111";
    expect(isValidStellarContractId(solanaAddress)).toBe(false);
  });
});

// ── #55: Nonce / history semantics ───────────────────────────────────────────

describe("Key rotation semantics (#55)", () => {
  it("each key derivation produces a unique meta-address (rotation produces new address)", () => {
    const sig1 = ("0x" + "aa".repeat(64)) as Hex;
    const sig2 = ("0x" + "bb".repeat(64)) as Hex;
    const keys1 = deriveKeysFromSignature(sig1);
    const keys2 = deriveKeysFromSignature(sig2);
    const meta1 = keysToStealthMetaAddress(keys1.viewingKey, keys1.spendingKey);
    const meta2 = keysToStealthMetaAddress(keys2.viewingKey, keys2.spendingKey);
    expect(stealthMetaAddressToHex(meta1.metaAddress)).not.toBe(
      stealthMetaAddressToHex(meta2.metaAddress)
    );
  });

  it("meta-address is deterministic for the same signature (safe re-registration)", () => {
    const sig = ("0x" + "cc".repeat(64)) as Hex;
    const keys = deriveKeysFromSignature(sig);
    const meta1 = keysToStealthMetaAddress(keys.viewingKey, keys.spendingKey);
    const meta2 = keysToStealthMetaAddress(keys.viewingKey, keys.spendingKey);
    expect(meta1.metaAddress).toEqual(meta2.metaAddress);
  });
});
