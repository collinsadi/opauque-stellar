import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  MAINNET_AUDIT_COMPONENTS,
  MAINNET_SIGNOFF_STATUS,
  OPEN_BLOCKING_FINDING_IDS,
  SECURITY_AUDIT_DOCS,
  isMainnetAuditApproved,
  isMainnetDeployAllowedByAudit,
} from "../lib/securityAudit";

describe("securityAudit", () => {
  it("documents all mainnet audit components", () => {
    expect(MAINNET_AUDIT_COMPONENTS.length).toBe(5);
    expect(MAINNET_AUDIT_COMPONENTS.some((c) => c.includes("contracts"))).toBe(true);
    expect(MAINNET_AUDIT_COMPONENTS.some((c) => c.includes("Frontend"))).toBe(true);
  });

  it("references audit documentation paths", () => {
    expect(SECURITY_AUDIT_DOCS.findings).toContain("mainnet-audit-findings.json");
    expect(SECURITY_AUDIT_DOCS.signoff).toContain("SIGNOFF");
  });

  it("aligns TS constants with findings JSON register", () => {
    const root = resolve(import.meta.dirname, "../../..");
    const raw = readFileSync(resolve(root, SECURITY_AUDIT_DOCS.findings), "utf8");
    const data = JSON.parse(raw) as {
      signoffStatus: string;
      findings: Array<{ id: string; triage: string; status: string }>;
    };

    expect(data.signoffStatus).toBe(MAINNET_SIGNOFF_STATUS);

    const jsonBlockingOpen = data.findings
      .filter((f) => f.triage === "blocking" && f.status === "open")
      .map((f) => f.id)
      .sort();

    expect(jsonBlockingOpen).toEqual([...OPEN_BLOCKING_FINDING_IDS].sort());
  });

  it("blocks mainnet deploy until audit approved", () => {
    expect(isMainnetAuditApproved()).toBe(false);
    expect(isMainnetDeployAllowedByAudit()).toBe(false);
  });
});
