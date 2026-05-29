/**
 * destination-memo tests (#112).
 */

import { describe, it, expect } from "vitest";
import {
  memoRiskFor,
  validateMemo,
  memoWarningCopy,
} from "../destination-memo";

const KRAKEN = "GA5XIGA5C7QTPTWXQHY6MCJRMTRZDOSHR6EFIBNDQTCQHG262N4GGKTM";
const RANDOM_USER = "GA5XIGA5XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";

describe("memoRiskFor (#112)", () => {
  it("flags a known custodial address with the right name + recommended memo type", () => {
    const risk = memoRiskFor(KRAKEN);
    expect(risk.isKnownCustodian).toBe(true);
    expect(risk.custodianName).toBe("Kraken");
    expect(risk.recommendedMemoType).toBe("id");
  });

  it("returns no-risk for an unknown address", () => {
    expect(memoRiskFor(RANDOM_USER).isKnownCustodian).toBe(false);
  });

  it("is safe with null / undefined inputs", () => {
    expect(memoRiskFor(undefined).isKnownCustodian).toBe(false);
    expect(memoRiskFor(null).isKnownCustodian).toBe(false);
    expect(memoRiskFor("").isKnownCustodian).toBe(false);
  });

  it("trims whitespace before matching", () => {
    expect(memoRiskFor("   " + KRAKEN + "   ").isKnownCustodian).toBe(true);
  });
});

describe("validateMemo (#112)", () => {
  it('"none" + empty value passes; "none" + non-empty fails', () => {
    expect(validateMemo("none", "").ok).toBe(true);
    expect(validateMemo("none", "hi").ok).toBe(false);
  });

  it("text memo: <= 28 UTF-8 bytes", () => {
    expect(validateMemo("text", "deposit-2026-05-29").ok).toBe(true);
    expect(validateMemo("text", "x".repeat(29)).ok).toBe(false);
    // Multi-byte: 14 emoji × 4 bytes = 56 → over the cap.
    expect(validateMemo("text", "🙂".repeat(14)).ok).toBe(false);
  });

  it("id memo: unsigned 64-bit integer", () => {
    expect(validateMemo("id", "123456").ok).toBe(true);
    expect(validateMemo("id", "0").ok).toBe(true);
    expect(validateMemo("id", "-1").ok).toBe(false);
    expect(validateMemo("id", "abc").ok).toBe(false);
    expect(validateMemo("id", "18446744073709551616").ok).toBe(false); // 2^64
  });

  it("hash / return memo: 64 hex chars", () => {
    const goodHash = "a".repeat(64);
    expect(validateMemo("hash", goodHash).ok).toBe(true);
    expect(validateMemo("return", goodHash).ok).toBe(true);
    expect(validateMemo("hash", "a".repeat(63)).ok).toBe(false);
    expect(validateMemo("hash", "g".repeat(64)).ok).toBe(false);
  });

  it("non-`none` types require a value", () => {
    expect(validateMemo("text", "").ok).toBe(false);
    expect(validateMemo("id", "").ok).toBe(false);
  });
});

describe("memoWarningCopy (#112)", () => {
  it("returns the warning string when destination is custodial and memo is empty", () => {
    const warning = memoWarningCopy(memoRiskFor(KRAKEN), "");
    expect(warning).toMatch(/Kraken/i);
    expect(warning).toMatch(/may result in lost funds/i);
  });

  it("suppresses the warning when a memo IS provided", () => {
    expect(memoWarningCopy(memoRiskFor(KRAKEN), "12345")).toBeNull();
  });

  it("returns null for an unknown destination", () => {
    expect(memoWarningCopy(memoRiskFor(RANDOM_USER), "")).toBeNull();
  });
});
