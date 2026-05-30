import { describe, it, expect } from "vitest";
import {
  ADVERSARY_SUMMARY,
  MAINNET_PRIVACY_WARNINGS,
  MITIGATIONS,
  PRIVACY_NOT_HIDDEN,
  PRIVACY_PROVIDED,
  SEND_PRIVACY_WARNING,
  SCANNER_PRIVACY_WARNING,
  THREAT_MODEL_ROUTE,
} from "../lib/privacyThreatModel";

describe("privacyThreatModel", () => {
  it("exposes threat model route", () => {
    expect(THREAT_MODEL_ROUTE).toBe("/threat-model");
  });

  it("lists provided and residual privacy properties", () => {
    expect(PRIVACY_PROVIDED.length).toBeGreaterThan(0);
    expect(PRIVACY_NOT_HIDDEN.length).toBeGreaterThan(PRIVACY_PROVIDED.length - 1);
  });

  it("maps mitigations to implementation with unique ids", () => {
    const ids = MITIGATIONS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(MITIGATIONS.every((m) => m.implementation.length > 0)).toBe(true);
  });

  it("includes issue-linked mitigations", () => {
    const withIssues = MITIGATIONS.filter((m) => m.issue);
    expect(withIssues.some((m) => m.issue?.includes("#50"))).toBe(true);
    expect(withIssues.some((m) => m.issue?.includes("#85"))).toBe(true);
    expect(withIssues.some((m) => m.issue?.includes("#111"))).toBe(true);
  });

  it("defines adversary summary aligned with doc categories", () => {
    expect(ADVERSARY_SUMMARY.length).toBeGreaterThanOrEqual(5);
  });

  it("provides UI warning copy for key surfaces", () => {
    expect(MAINNET_PRIVACY_WARNINGS.length).toBe(3);
    expect(SEND_PRIVACY_WARNING).toMatch(/wallet/i);
    expect(SCANNER_PRIVACY_WARNING).toMatch(/RPC/i);
  });
});
