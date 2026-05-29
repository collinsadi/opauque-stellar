/**
 * log + redact tests (#115).
 */

import { describe, it, expect } from "vitest";
import { redact, redactAddress } from "../log";

const STELLAR_ADDR = "GA5XIGA5C7QTPTWXQHY6MCJRMTRZDOSHR6EFIBNDQTCQHG262N4GGKTM";

describe("redactAddress (#115)", () => {
  it("shortens a Stellar G-address to first 5 + last 4", () => {
    expect(redactAddress(STELLAR_ADDR)).toBe(`${STELLAR_ADDR.slice(0, 5)}…${STELLAR_ADDR.slice(-4)}`);
  });

  it("shortens a Soroban contract address (C…) too", () => {
    const c = "C" + STELLAR_ADDR.slice(1);
    expect(redactAddress(c)).toBe(`${c.slice(0, 5)}…${c.slice(-4)}`);
  });

  it("passes short strings through unchanged", () => {
    expect(redactAddress("hello")).toBe("hello");
    expect(redactAddress("")).toBe("");
  });

  it("ignores non-string input", () => {
    expect(redactAddress(123 as unknown as string)).toBe("");
    expect(redactAddress(null as unknown as string)).toBe("");
  });
});

describe("redact (#115)", () => {
  it("masks long hex blobs to a byte-count placeholder", () => {
    const hex = "0123456789abcdef".repeat(4);
    const out = redact(hex);
    expect(out).toMatch(/\[redacted-32-byte-hex\]/);
  });

  it("walks objects and redacts string fields", () => {
    const out = redact({
      from: STELLAR_ADDR,
      to: "GBBB" + "X".repeat(52),
      privateKey: "S".repeat(56),
      label: "rent payment",
    });
    expect(out).toMatchObject({
      from: `${STELLAR_ADDR.slice(0, 5)}…${STELLAR_ADDR.slice(-4)}`,
      privateKey: "[redacted-key]",
      label: "rent payment",
    });
  });

  it("recurses into nested arrays + objects", () => {
    const out = redact({ history: [{ counterparty: STELLAR_ADDR }, { counterparty: "alice" }] });
    expect((out as any).history[0].counterparty).toMatch(/…/);
    expect((out as any).history[1].counterparty).toBe("alice");
  });

  it("drops `__secret*` keys entirely", () => {
    const out = redact({ __secretSeed: "0xdeadbeef", visible: 1 });
    expect(out).toEqual({ visible: 1 });
  });

  it("redacts every common private-key field name regardless of casing", () => {
    const out = redact({
      privateKey: "x",
      secretKey: "y",
      seed: "z",
      mnemonic: "abandon abandon abandon …",
      signingKey: "k",
      encryptionKey: "k",
    });
    for (const v of Object.values(out as Record<string, unknown>)) {
      expect(v).toBe("[redacted-key]");
    }
  });

  it("is safe on circular structures", () => {
    const o: Record<string, unknown> = { a: 1 };
    o.self = o;
    const out = redact(o) as Record<string, unknown>;
    expect(out.a).toBe(1);
    expect(out.self).toBe("[circular]");
  });

  it("preserves primitive values", () => {
    expect(redact(42)).toBe(42);
    expect(redact(true)).toBe(true);
    expect(redact(null)).toBe(null);
    expect(redact(undefined)).toBe(undefined);
  });
});
