# Mainnet Security Audit — Internal Signoff

**Release:** v1  
**Date:** 2026-05-29  
**Decision:** **BLOCKED** — do not deploy mainnet with real funds

---

## Signoff record

| Field | Value |
|-------|-------|
| Findings register | [mainnet-audit-findings.json](./mainnet-audit-findings.json) |
| Audit report | [MAINNET_AUDIT_REPORT.md](./MAINNET_AUDIT_REPORT.md) |
| Scope | [MAINNET_AUDIT_SCOPE.md](./MAINNET_AUDIT_SCOPE.md) |
| `signoffStatus` | `blocked` |
| Blocking findings open | 4 (SEC-001, SEC-002, SEC-003, SEC-004) |
| Findings remediated | 9 |
| Accepted risks documented | 3 |

---

## Approval checklist

| # | Criterion | Status |
|---|-----------|--------|
| 1 | Audit scope covers all mainnet components (contracts, circuits, scanner, frontend keys, ops) | Done |
| 2 | Findings triaged with severity and blocking status | Done |
| 3 | Remediated findings linked to implementation | Done |
| 4 | Independent third-party audit completed | **Not done** (SEC-001) |
| 5 | Production ZK trusted setup completed | **Not done** (SEC-002) |
| 6 | Mainnet multisig deployed and recorded | **Not done** (SEC-004) |
| 7 | Zero open blocking findings | **Not met** |
| 8 | `verify-security-audit.mjs --require-approved` passes | **Not met** |

---

## Signatures

| Role | Name | Signature | Date |
|------|------|-----------|------|
| Security review lead | _Pending_ | | |
| Protocol lead | _Pending_ | | |
| Operations lead | _Pending_ | | |

---

## To approve mainnet

1. Close or waive all blocking findings with documented rationale.
2. Set `"signoffStatus": "approved"` in [mainnet-audit-findings.json](./mainnet-audit-findings.json).
3. Attach external audit report reference (if applicable) to this document.
4. Complete signature table above.
5. Verify: `node scripts/verify-security-audit.mjs --network mainnet --require-approved`

Until then, `deployments/v1/mainnet.json` must remain `deploymentStatus: not_deployed`.

---

_Internal signoff v1.0.0 — structured review performed 2026-05-29_
