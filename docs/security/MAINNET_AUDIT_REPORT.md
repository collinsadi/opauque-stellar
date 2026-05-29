# Mainnet Security Audit — Final Report

**Release:** v1  
**Review type:** Internal structured review  
**Review date:** 2026-05-29  
**Signoff status:** **BLOCKED** — mainnet deploy not approved

Attachments: [Findings register](./mainnet-audit-findings.json) · [Signoff](./MAINNET_AUDIT_SIGNOFF.md) · [Scope](./MAINNET_AUDIT_SCOPE.md)

---

## Executive summary

The Opaque core team performed a structured security review of all mainnet v1 components: six Soroban contracts, Groth16 circuits, Rust WASM scanner cryptography, frontend key handling, and deployment operations.

**Result:** Mainnet deployment with real funds is **not approved**. Four blocking findings remain open, including the absence of an independent third-party audit and production-grade trusted setup for ZK circuits.

Nine previously identified risks have been remediated in code or CI. Three residual risks are documented as accepted with mitigations.

---

## Scope coverage

| Component | Reviewed | Artifacts |
|-----------|----------|-----------|
| Soroban contracts (6 packages) | Yes | `contracts/*`, unit tests, manifest WASM hashes |
| ZK circuits v1/v2 | Yes | `circuits/v2/`, artifact hashes, VK binding |
| Scanner WASM | Yes | `scanner/`, `artifacts/manifest.json` |
| Frontend key handling | Yes | KeysContext, ghostCrypto, stealthLifecycle, recovery |
| Deployment operations | Yes | Manifests, CI workflows, RUNBOOK.md |

Full inventory: [MAINNET_AUDIT_SCOPE.md](./MAINNET_AUDIT_SCOPE.md).

---

## Findings summary

| Triage | Open | Remediated | Accepted risk |
|--------|------|------------|---------------|
| Blocking | 4 | 9 | — |
| Accepted risk | — | — | 3 |

### Open blocking findings

| ID | Title | Severity |
|----|-------|----------|
| SEC-001 | No independent third-party security audit | Critical |
| SEC-002 | Development Groth16 trusted setup artifacts | Critical |
| SEC-003 | Soroban contracts lack formal verification / external audit | High |
| SEC-004 | Mainnet multisig governance not deployed | High |

### Remediated (representative)

| ID | Title | Mitigation |
|----|-------|------------|
| SEC-101 | Ghost keys plaintext at rest | AES-256-GCM encryption |
| SEC-102 | Master keys persisted | Memory-only KeysContext |
| SEC-103 | Artifact drift | CI hash verification |
| SEC-104 | Invalid announcement keys | #53 validation |
| SEC-105 | Event version drift | #50 filtering |
| SEC-106 | Network mismatch signing | networkValidation service |
| SEC-107 | Setup signature replay | Domain-separated messages |
| SEC-108 | Reputation root incident | #85 freeze policy |
| SEC-109 | Legacy config in production | Manifest + CI guards |

### Accepted risk (documented)

| ID | Title |
|----|-------|
| SEC-201 | Browser memory key exposure |
| SEC-202 | XSS at password entry |
| SEC-203 | On-chain metadata linkage |

---

## Recommendations before mainnet

1. **Commission external audit** covering contracts, circuits, scanner, and frontend key flows (SEC-001, SEC-003).
2. **Production trusted setup** for Groth16 with multi-party ceremony; re-pin artifact hashes (SEC-002).
3. **Deploy with multisig admin**; record governance accounts in `deployments/v1/mainnet.json` (SEC-004).
4. Re-run `node scripts/verify-security-audit.mjs --network mainnet --require-approved` after remediation.
5. Update signoff to `approved` in findings JSON and obtain protocol + security lead signatures.

---

## Verification

```bash
# Validate findings register and print status
node scripts/verify-security-audit.mjs --network mainnet

# Gate mainnet deploy (fails until signoff approved)
node scripts/verify-security-audit.mjs --network mainnet --require-approved
```

---

_Report version 1.0.0 — 2026-05-29_
