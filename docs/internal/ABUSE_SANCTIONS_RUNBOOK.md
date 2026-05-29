# Internal Runbook — Abuse and Sanctions Response

**Classification:** Operator / team internal  
**Public policy:** [ABUSE_AND_SANCTIONS_POLICY.md](../ABUSE_AND_SANCTIONS_POLICY.md)

This runbook defines **how the team handles abuse reports** without improvising. Do not deanonymize users or freeze funds beyond infrastructure and governance controls documented here.

---

## 1. Roles and contacts

| Role | Responsibility | Contact |
|------|----------------|---------|
| **Abuse triage lead** | First response, intake, severity assignment | `abuse@opaqueprotocol.org` → on-call rotation |
| **Security lead** | Vulnerabilities, active exploitation, key compromise | `security@opaqueprotocol.org` |
| **Incident commander** | P0/P1 coordination, comms | `#ops-channel` (Discord) · `incident@opaqueprotocol.org` |
| **Protocol admin** | Multisig freeze/unfreeze, contract actions | Multisig signers (see [RUNBOOK.md](../RUNBOOK.md)) |
| **Legal counsel** | Subpoenas, sanctions lists, law-enforcement requests | Engage via incident commander — **do not respond alone** |

### Escalation matrix

| Severity | Examples | Response time | Escalate to |
|----------|----------|---------------|-------------|
| **P0** | Active exploit, compromised admin keys, imminent sanctions violation on operated infra | 1 hour | Incident commander + security lead + legal |
| **P1** | Credible fraud/phishing using official domains, repeated abuse from hosted deployment | 4 hours | Abuse triage lead + incident commander |
| **P2** | Terms violation report, spam payment links, non-urgent sanctions inquiry | 2 business days | Abuse triage lead |
| **P3** | General questions, incomplete reports | 5 business days | Abuse triage lead |

---

## 2. Intake checklist

When a report arrives (email, GitHub, Discord):

- [ ] Assign ticket ID and triage owner
- [ ] Record **source**, **timestamp**, and **reporter contact** (if provided)
- [ ] Classify: abuse / sanctions / security / legal / other
- [ ] Assign severity (P0–P3)
- [ ] Verify evidence (tx hashes, URLs, addresses) — **do not** execute suspicious links on operator machines
- [ ] Determine if report involves **infrastructure we control** vs **pure on-chain third-party activity**
- [ ] Log decision and actions in incident tracker (redact reporter PII in shared channels)

**Do not promise** fund recovery, identity disclosure, or on-chain transaction reversal.

---

## 3. Response playbooks

### 3.1 Hosted frontend / CDN abuse

**Triggers:** Phishing clone, malware distribution, impersonation using official branding.

1. Confirm the artifact or domain is **ours** (deployment manifest, CDN config).
2. Remove or rollback frontend per [RUNBOOK.md § Frontend Rollback](../RUNBOOK.md).
3. Publish status update if user-facing outage occurs.
4. Reply to reporter with acknowledgment (template §6).
5. If criminal activity, preserve logs and escalate to legal before sharing data externally.

**Cannot do:** Block users' browsers from accessing self-hosted or third-party builds.

### 3.2 Payment-link or documentation abuse

**Triggers:** Malicious `/pay/:identifier` links on **our** domain, abusive content in **our** repo/wiki.

1. Remove hosted content or disable route in deployment if technically feasible.
2. Open GitHub issue/PR to fix if repo content is affected.
3. Document Stellar tx hashes for public record only — no key recovery attempts.

### 3.3 Sanctions-related report

**Triggers:** Report cites OFAC/EU/UK list match, embargoed jurisdiction access via **our** hosted UI.

1. **Stop** — escalate to legal counsel before public statements.
2. Confirm whether subject is **infrastructure access** (blockable) vs **on-chain address** (not blockable by us).
3. Available actions:
   - Geo/IP block on CDN (where legally required and technically supported)
   - Display interstitial or disable official hosted app in affected region
   - Freeze reputation root if attestations are implicated (#85) — see [FREEZE_INCIDENT_RUNBOOK](../../frontend/src/lib/freezePolicy.ts)
4. **Unavailable actions:** Freeze stealth XLM, censor Stellar ledger, deanonymize recipient.
5. Document outcome; retain report per policy retention (24 months default).

### 3.4 Reputation / attestation abuse

**Triggers:** Fraudulent attestations, compromised issuer, false proofs.

1. Assess whether root or issuer keys are compromised.
2. If yes → execute [Emergency Freeze Runbook](../../frontend/src/lib/freezePolicy.ts) (`FREEZE_INCIDENT_RUNBOOK`).
3. Notify community via #announcements with factual, non-accusatory language.
4. Coordinate unfreeze only after root cause remediated.

### 3.5 Law-enforcement or legal request

1. Forward to legal counsel immediately.
2. Do not provide user data we do not possess (we have no account database).
3. Disclose only what counsel approves: infrastructure logs, deployment metadata, public chain data.
4. Document request ID, scope, and response date.

### 3.6 Pure on-chain report (out of scope)

**Triggers:** Reporter asks us to block a stealth payment between third parties.

1. Acknowledge receipt.
2. Explain non-custodial limits (public policy §5).
3. Suggest reporter contact exchanges, wallet providers, or authorities with tx evidence.
4. Close as **informational / no action available** unless our hosted infra is involved.

---

## 4. Infrastructure action reference

| Action | Owner | Tooling |
|--------|-------|---------|
| Frontend rollback | Incident commander | [RUNBOOK.md § Frontend Rollback](../RUNBOOK.md) |
| RPC rate limit / IP block | Infra on-call | Provider dashboard (only endpoints **we** operate) |
| Reputation root freeze | Protocol admin multisig | `freeze_roots()` via Stellar multisig |
| GitHub content removal | Repo admin | GitHub UI / PR revert |
| Status communication | Incident commander | Status page, #announcements |

---

## 5. Privacy and data handling

| Data type | Handling |
|-----------|----------|
| Reporter email | Store in ticket system; restrict access to triage + legal |
| Reporter IP (if in CDN logs) | Access only for incident investigation; min retention |
| Wallet addresses in report | Treat as public blockchain data; do not link to real-world identity without legal process |
| Stealth/meta-addresses | Same as above — **no** client-side key derivation to identify users |

**Prohibited:** Running forensic tracing, contacting users based on chain analysis, or sharing reporter details with accused parties.

---

## 6. Communication templates

### Acknowledgment (abuse report)

> Thank you for your report ([TICKET-ID]). We have received your submission and aim to respond within [5 business days / SLA for severity]. Opaque is a non-custodial protocol; we cannot reverse on-chain transactions or access user private keys. We will take action within infrastructure we control where applicable.

### No action available (on-chain only)

> We reviewed your report ([TICKET-ID]). The activity described occurs on the public Stellar network between non-custodial wallets. Opaque operators cannot freeze, reverse, or deanonymize these transactions. We recommend sharing your evidence with relevant service providers or authorities.

### Infrastructure action taken

> We reviewed your report ([TICKET-ID]) and took action on [date] regarding [hosted frontend / documentation / operated RPC]. Details: [brief factual summary]. We do not disclose user identity as part of this process.

---

## 7. Related documents

- [Public abuse policy](../ABUSE_AND_SANCTIONS_POLICY.md)
- [Mainnet operations runbook](../RUNBOOK.md)
- [Emergency freeze runbook](../../frontend/src/lib/freezePolicy.ts) (Issue #85)
- [SECURITY.md](../../SECURITY.md) — vulnerability reporting

---

## 8. Review cadence

- **Quarterly:** Review contacts, escalation paths, and template accuracy.
- **After each P0/P1:** Post-incident review within 5 business days.

_Last updated: 2026-05-29_
