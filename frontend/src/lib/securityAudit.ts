/**
 * Mainnet security audit status — aligned with docs/security/mainnet-audit-findings.json
 */

export const SECURITY_AUDIT_DOCS = {
  scope: "docs/security/MAINNET_AUDIT_SCOPE.md",
  report: "docs/security/MAINNET_AUDIT_REPORT.md",
  signoff: "docs/security/MAINNET_AUDIT_SIGNOFF.md",
  findings: "docs/security/mainnet-audit-findings.json",
} as const;

export const MAINNET_AUDIT_COMPONENTS = [
  "Soroban contracts (6 packages)",
  "ZK circuits (v1/v2)",
  "Scanner WASM cryptography",
  "Frontend key handling",
  "Deployment operations",
] as const;

/** Current signoff status from findings register (update when JSON changes). */
export const MAINNET_SIGNOFF_STATUS = "blocked" as const;

export const OPEN_BLOCKING_FINDING_IDS = [
  "SEC-001",
  "SEC-002",
  "SEC-003",
  "SEC-004",
] as const;

export function isMainnetAuditApproved(): boolean {
  return MAINNET_SIGNOFF_STATUS === "approved";
}

export function isMainnetDeployAllowedByAudit(): boolean {
  return isMainnetAuditApproved() && OPEN_BLOCKING_FINDING_IDS.length === 0;
}
