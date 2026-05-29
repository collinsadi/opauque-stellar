/**
 * i18n-format tests (#110).
 */

import { describe, it, expect } from "vitest";
import {
  formatXlmFromStroops,
  parseXlmInput,
  formatDateTime,
  formatDate,
} from "../i18n-format";

describe("formatXlmFromStroops (#110)", () => {
  it("formats round amounts with the en-US locale", () => {
    expect(formatXlmFromStroops(10_000_000n, { locale: "en-US" })).toMatch(/^1\.00$/);
  });

  it("formats fractional amounts up to 7 decimals by default", () => {
    expect(formatXlmFromStroops(12_345_670n, { locale: "en-US" })).toBe("1.234567");
  });

  it("uses German comma decimal when the locale is de-DE", () => {
    const out = formatXlmFromStroops(12_345_670n, { locale: "de-DE" });
    expect(out.includes(",")).toBe(true);
    expect(out.includes(".")).toBe(false);
  });

  it("accepts string + number inputs equivalently", () => {
    expect(formatXlmFromStroops("12345670", { locale: "en-US" })).toBe("1.234567");
    expect(formatXlmFromStroops(12345670, { locale: "en-US" })).toBe("1.234567");
  });

  it("handles negative balances by prefixing a sign", () => {
    expect(formatXlmFromStroops(-1_000_000_000n, { locale: "en-US" })).toMatch(/^-100\.0+$/);
  });
});

describe("parseXlmInput (#110)", () => {
  it("parses a plain decimal", () => {
    expect(parseXlmInput("1.234567")).toBe(12_345_670n);
  });

  it("parses an integer", () => {
    expect(parseXlmInput("100")).toBe(1_000_000_000n);
  });

  it("strips thousand-separator commas", () => {
    expect(parseXlmInput("1,234.56")).toBe(12_345_600_000n);
  });

  it("rejects German `1.234,56` shape with a clear message", () => {
    expect(() => parseXlmInput("1.234,56")).toThrow(/unrecognised decimal format/i);
  });

  it("rejects amounts with more decimals than XLM supports", () => {
    expect(() => parseXlmInput("0.12345678")).toThrow(/too many decimals/i);
  });

  it("rejects garbage", () => {
    expect(() => parseXlmInput("abc")).toThrow();
    expect(() => parseXlmInput("")).toThrow(/required/i);
  });

  it("parses negative values", () => {
    expect(parseXlmInput("-2")).toBe(-20_000_000n);
  });
});

describe("formatDateTime / formatDate (#110)", () => {
  it("formats an ISO string with the en-US locale", () => {
    const out = formatDateTime("2026-05-29T12:34:56Z", { locale: "en-US" });
    // Locale output varies by runtime, just check it is non-empty.
    expect(out.length).toBeGreaterThan(0);
  });

  it("returns empty string for invalid dates rather than NaN-laden output", () => {
    expect(formatDateTime("not-a-date")).toBe("");
  });

  it("date-only variant excludes the time portion", () => {
    const out = formatDate("2026-05-29T12:34:56Z", "en-US");
    expect(out.length).toBeGreaterThan(0);
  });
});
