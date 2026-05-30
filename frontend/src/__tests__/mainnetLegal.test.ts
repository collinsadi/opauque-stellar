import { describe, it, expect } from "vitest";
import {
  canProceedToMainnet,
  MAINNET_LEGAL_DOCS,
  requiresMainnetLegalAck,
} from "../lib/mainnetLegal";

describe("mainnetLegal", () => {
  it("lists all required legal documents", () => {
    expect(MAINNET_LEGAL_DOCS.map((d) => d.path)).toEqual([
      "/terms",
      "/privacy",
      "/disclaimer",
    ]);
  });

  it("requires acknowledgment on mainnet until accepted", () => {
    expect(
      requiresMainnetLegalAck({ expectedNetwork: "mainnet", hasAcknowledgedMainnetRisk: false }),
    ).toBe(true);
    expect(
      requiresMainnetLegalAck({ expectedNetwork: "mainnet", hasAcknowledgedMainnetRisk: true }),
    ).toBe(false);
    expect(
      requiresMainnetLegalAck({ expectedNetwork: "testnet", hasAcknowledgedMainnetRisk: false }),
    ).toBe(false);
  });

  it("requires both legal and funds checkboxes before proceeding", () => {
    expect(canProceedToMainnet(false, false)).toBe(false);
    expect(canProceedToMainnet(true, false)).toBe(false);
    expect(canProceedToMainnet(false, true)).toBe(false);
    expect(canProceedToMainnet(true, true)).toBe(true);
  });
});
