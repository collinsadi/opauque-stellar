# Mainnet Security Audit — Scope

Formal security review scope for Opaque Stellar **mainnet v1**. Privacy and fund-handling code must not reach mainnet without completing this audit and resolving **blocking** findings tracked in [`mainnet-audit-findings.json`](./mainnet-audit-findings.json).

Related: [Audit report](./MAINNET_AUDIT_REPORT.md) · [Signoff](./MAINNET_AUDIT_SIGNOFF.md)

---

## 1. Audit objectives

1. Identify vulnerabilities in fund-handling and privacy-critical paths before mainnet.
2. Triage findings as **blocking**, **remediated**, or **accepted risk** (documented).
3. Produce a final report and internal signoff before `deploymentStatus: deployed` on mainnet.

---

## 2. In-scope components

### 2.1 Soroban smart contracts

| Package | Path | Fund / privacy relevance |
|---------|------|--------------------------|
| `stealth-registry` | `contracts/stealth-registry/` | Meta-address registration, identity binding |
| `stealth-announcer` | `contracts/stealth-announcer/` | Payment announcements, view-tag metadata |
| `groth16-verifier` | `contracts/groth16-verifier/` | On-chain ZK proof verification |
| `reputation-verifier` | `contracts/reputation-verifier/` | Reputation proof verification |
| `schema-registry` | `contracts/schema-registry/` | Attestation schema definitions |
| `attestation-engine-v2` | `contracts/attestation-engine-v2/` | Nullifiers, attestations, pause/freeze |
| `opaque-schema-core` | `contracts/opaque-schema-core/` | Shared schema encoding (#44 / #45) |

**Review focus:** access control, admin/multisig paths, nullifier replay, input validation, upgrade authority, event versioning (#50), key prefix checks (#53), emergency freeze (#85).

### 2.2 ZK circuits

| Artifact | Path | Review focus |
|----------|------|--------------|
| Circom v1 / v2 circuits | `circuits/v2/` | Constraint soundness, public signal leakage |
| Proving / verification keys | `circuits/v2/*.zkey`, VK JSON | Trusted setup provenance, hash binding |
| snarkjs integration | `frontend` prover paths | Witness generation, proof malleability |
| Embedded contract VK | `groth16-verifier` constants | VK ↔ zkey binding (`zkeyHashBinding`) |

**Review focus:** Trusted setup ceremony (production vs dev), Groth16 soundness assumptions, selective disclosure public inputs ([PUBLIC_SIGNALS.md](../PUBLIC_SIGNALS.md)).

### 2.3 Scanner cryptography (Rust → WASM)

| Component | Path | Review focus |
|-----------|------|--------------|
| WASM scanner | `scanner/` | ECDH derivation, view-tag filter, announcement parsing |
| Frontend integration | `frontend/src/hooks/useScanner.ts` | Cache integrity, missed-event handling |
| Artifact hash | `artifacts/manifest.json` | Reproducible builds |

**Review focus:** False-positive view-tag rate (~1/256), invalid key rejection (#53), event version skips (#50), timing side channels in batch scan.

### 2.4 Frontend key handling & fund flows

| Area | Path | Review focus |
|------|------|--------------|
| Master keys | `frontend/src/context/KeysContext.tsx` | Memory-only storage, logout clearing |
| Ghost encryption | `frontend/src/lib/ghostCrypto.ts` | AES-256-GCM, PBKDF2 parameters |
| Ghost storage | `frontend/src/store/ghostAddressStore.ts` | Ciphertext at rest ([GHOST_THREAT_MODEL.md](../GHOST_THREAT_MODEL.md)) |
| Signature session | `frontend/src/lib/signatureSession.ts` | Ephemeral encryption of setup signatures |
| Stealth lifecycle | `frontend/src/lib/stealthLifecycle.ts` | Send, sweep, withdrawal correctness |
| Stealth crypto | `frontend/src/lib/stealth.ts` | DKSAP derivation, domain-separated signing |
| Network validation | `frontend/src/services/networkValidation.ts` | Pre-sign network checks |
| Recovery | `frontend/src/components/recovery/` | Backup export/import encryption |
| Send / balance UI | `SendView.tsx`, `PrivateBalanceView.tsx` | User-facing fund operations |

**Review focus:** Key material never written plaintext to `localStorage`, XSS at password entry, wrong-network signing, amount parsing, fee reserve handling.

### 2.5 Deployment & operations

| Area | Path | Review focus |
|------|------|--------------|
| Deployment manifests | `deployments/v1/mainnet.json` | Contract IDs, WASM hashes, status |
| Manifest verification | `scripts/verify-deployment-manifest.mjs` | Schema, hash checks, legacy rejection |
| Artifact manifest | `artifacts/manifest.json` | Scanner + circuit hash pins |
| CI / release gates | `.github/workflows/ci.yml`, `release.yml` | Reproducible build evidence |
| Mainnet runbook | `docs/RUNBOOK.md` | Incident response, multisig procedures |
| Admin panel ops | `frontend/src/components/AdminPanel.tsx` | Multisig guidance |

**Review focus:** Supply-chain integrity, manifest tampering, deployer key rotation, multisig before mainnet admin.

---

## 3. Out of scope

- Third-party wallets (Freighter) and Stellar core consensus
- Self-hosted forks not using official manifests
- Legal / sanctions policy (see abuse policy docs)
- Penetration testing of Stellar Foundation infrastructure

---

## 4. Methodology

| Phase | Activity | Output |
|-------|----------|--------|
| **Scoping** | Component inventory (this document) | Scope sign-off |
| **Review** | Manual code review + existing unit/regression tests | Findings in JSON register |
| **Triage** | Severity + blocking status assignment | Updated findings |
| **Remediation** | Fix or document accepted risk | `status: remediated` or `accepted_risk` |
| **Signoff** | Security lead + protocol lead approval | [MAINNET_AUDIT_SIGNOFF.md](./MAINNET_AUDIT_SIGNOFF.md) |

External third-party audit may supplement or replace internal review; update findings register with auditor report reference.

---

## 5. Exit criteria (mainnet deploy)

Mainnet `deploymentStatus` may move to `deployed` only when:

- [ ] All **blocking** findings are `remediated` or formally waived with signoff
- [ ] `signoffStatus` in findings JSON is `approved`
- [ ] `node scripts/verify-security-audit.mjs --network mainnet --require-approved` passes
- [ ] Final report attached: [MAINNET_AUDIT_REPORT.md](./MAINNET_AUDIT_REPORT.md)

---

_Last updated: 2026-05-29_
