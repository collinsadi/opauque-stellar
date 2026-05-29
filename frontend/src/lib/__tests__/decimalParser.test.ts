/**
 * Tests for string-based decimal parsing for XLM amounts.
 */

import { describe, it, expect } from "vitest";
import {
  parseXlmToStroops,
  parseHorizonBalanceToStroops,
  formatStroopsToXlm,
} from "../decimalParser";

describe("parseXlmToStroops", () => {
  it("should parse integer XLM amounts", () => {
    expect(parseXlmToStroops("1")).toBe(10_000_000n);
    expect(parseXlmToStroops("100")).toBe(1_000_000_000n);
    expect(parseXlmToStroops("0")).toBe(0n);
  });

  it("should parse decimal XLM amounts", () => {
    expect(parseXlmToStroops("1.5")).toBe(15_000_000n);
    expect(parseXlmToStroops("0.1")).toBe(1_000_000n);
    expect(parseXlmToStroops("0.0000001")).toBe(1n);
  });

  it("should handle 7 decimal places exactly", () => {
    expect(parseXlmToStroops("1.2345678")).rejects.toThrow();
    expect(parseXlmToStroops("1.1234567")).toBe(11_234_567n);
  });

  it("should reject invalid input", () => {
    expect(() => parseXlmToStroops("")).toThrow();
    expect(() => parseXlmToStroops("abc")).toThrow();
    expect(() => parseXlmToStroops("1.2.3")).toThrow();
  });

  it("should handle edge cases", () => {
    expect(parseXlmToStroops("0.0000000")).toBe(0n);
    expect(parseXlmToStroops("999999999.9999999")).toBe(9_999_999_999_999_999n);
  });
});

describe("parseHorizonBalanceToStroops", () => {
  it("should parse Horizon balance strings", () => {
    expect(parseHorizonBalanceToStroops("100.0000000")).toBe(1_000_000_000n);
    expect(parseHorizonBalanceToStroops("1.5000000")).toBe(15_000_000n);
  });

  it("should handle undefined and empty strings", () => {
    expect(parseHorizonBalanceToStroops(undefined)).toBe(0n);
    expect(parseHorizonBalanceToStroops("")).toBe(0n);
  });

  it("should handle malformed input gracefully", () => {
    expect(parseHorizonBalanceToStroops("invalid")).toBe(0n);
  });
});

describe("formatStroopsToXlm", () => {
  it("should format stroops to XLM", () => {
    expect(formatStroopsToXlm(10_000_000n)).toBe("1");
    expect(formatStroopsToXlm(15_000_000n)).toBe("1.5");
    expect(formatStroopsToXlm(1n)).toBe("0.0000001");
  });

  it("should remove trailing zeros", () => {
    expect(formatStroopsToXlm(10_000_000n)).toBe("1");
    expect(formatStroopsToXlm(10_500_000n)).toBe("1.05");
  });

  it("should handle zero", () => {
    expect(formatStroopsToXlm(0n)).toBe("0");
  });

  it("should handle large amounts", () => {
    expect(formatStroopsToXlm(1_000_000_000_000n)).toBe("100000");
  });
});
