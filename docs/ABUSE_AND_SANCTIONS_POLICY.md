# Abuse and Sanctions Response Policy

This policy defines how the Opaque team responds to abuse reports and sanctions-related concerns for the **reference wallet**, **hosted deployments**, and **protocol operations** we control.

Opaque is a **non-custodial** open protocol. We do not hold user funds, operate a centralized ledger, or deanonymize stealth payment users by default. This policy explains what we **can** and **cannot** do when abuse is reported.

For operator procedures, see [internal runbook](./internal/ABUSE_SANCTIONS_RUNBOOK.md) (team access).

---

## 1. Scope

This policy applies to:

- The Opaque reference frontend and documentation we publish
- Infrastructure we operate (CDN hosting, RPC endpoints we run, status pages)
- Reputation and attestation contracts where governance multisig controls exist
- Abuse reports about payment links, hosted UI, or protocol misuse

This policy does **not** apply to:

- Third-party wallets (e.g. Freighter), exchanges, or Stellar network validators
- Self-hosted forks of the open-source software
- On-chain stealth transfers we cannot reverse or block

---

## 2. Prohibited use

Use of Opaque-hosted interfaces and official deployments is prohibited for:

- Sanctions evasion or transactions involving sanctioned persons or entities
- Fraud, theft, ransomware, or extortion
- Money laundering where prohibited by applicable law
- Distribution of malware or phishing via payment links or impersonation
- Any activity illegal in the jurisdiction of the reporter, user, or operator

Privacy features do not exempt users from applicable law. Users remain responsible for compliance.

---

## 3. How to report abuse

Submit a report with as much detail as possible:

| Field | Guidance |
|-------|----------|
| **What happened** | Describe the abusive activity |
| **Evidence** | Transaction hashes, Stellar addresses, payment-link URLs, screenshots |
| **Timeframe** | When the activity occurred |
| **Your contact** | Email for follow-up (optional for anonymous reports) |

### Reporting channels

| Channel | Use for |
|---------|---------|
| **Abuse email** | [`abuse@opaqueprotocol.org`](mailto:abuse@opaqueprotocol.org) | General abuse, sanctions concerns, Terms violations |
| **Security email** | [`security@opaqueprotocol.org`](mailto:security@opaqueprotocol.org) | Vulnerabilities, active exploitation, credential compromise |
| **GitHub Issues** | [opaque-stellar issues](https://github.com/collinsadi/opaque-stellar/issues) | Public bug reports; use **only** when no sensitive victim data is included |
| **GitHub Security Advisories** | [Private advisory](https://github.com/collinsadi/opaque-stellar/security/advisories/new) | Sensitive security incidents |

We aim to acknowledge abuse reports within **5 business days**. Complex or legal matters may take longer; we will communicate status updates when possible.

---

## 4. What we can block or limit

When we operate infrastructure, we **may**:

| Action | Applies to |
|--------|------------|
| Remove or disable a **hosted frontend** build or CDN artifact | Deployments we control |
| Block or rate-limit access to **RPC/Horizon endpoints we operate** | Our infrastructure only |
| Freeze **reputation root updates** via governance multisig | Attestation/reputation contracts (#85) |
| Revoke or pause **issuer attestations** we administrate | Where we are the issuer/admin |
| Remove **documentation or payment-link landing pages** we host | Our domains and repos |
| Cooperate with **valid legal process** as required by law | Within jurisdiction and counsel guidance |

---

## 5. What we cannot block

Because Opaque is non-custodial and on-chain:

| Limitation | Reason |
|------------|--------|
| **Cannot freeze or seize user XLM** in stealth or public Stellar accounts | No custodial access to private keys |
| **Cannot reverse** confirmed Stellar transactions | Ledger immutability |
| **Cannot block** third-party wallets from signing transactions | Wallets are independent |
| **Cannot deanonymize** stealth recipients from protocol design alone | Stealth keys are client-side |
| **Cannot remove** data already published on Stellar | Public blockchain |
| **Cannot enforce** policy on self-hosted forks | Open-source software |

Reports involving purely on-chain activity between third-party wallets may be redirected to relevant exchanges, hosts, or authorities.

---

## 6. Privacy guarantees

### For users

- The protocol and reference app **do not collect** names, emails, or IP addresses as part of normal operation (see [Privacy Policy](/privacy) in the app).
- We **do not** sell user data or provide bulk blockchain surveillance.
- Operational logs on infrastructure we run (e.g. CDN access logs) may exist; we minimize retention and do not use them for profiling.

### For reporters

- Reports are used **only** for triage, abuse response, and legal compliance.
- We do not publish reporter identities without consent, except as required by law.
- Anonymous reports are accepted; providing contact information helps resolution.
- We **do not** promise to identify or deanonymize blockchain users based on abuse reports alone.

### What we may retain

- Report content, evidence hashes, and operator notes for **up to 24 months** unless a longer period is required for legal holds.
- Aggregated, non-identifying statistics for policy improvement.

---

## 7. Sanctions compliance

Operators of official deployments screen activity **only within infrastructure they control** (e.g. blocking access to a hosted UI in embargoed jurisdictions where required).

Users must not use Opaque to evade applicable sanctions. When we receive credible sanctions-related reports:

1. We triage under the [internal runbook](./internal/ABUSE_SANCTIONS_RUNBOOK.md).
2. We take available infrastructure actions (Section 4).
3. We escalate to legal counsel when required.
4. We do **not** represent that on-chain privacy tools substitute for sanctions screening of counterparties.

---

## 8. Incident and support contacts

| Role | Contact |
|------|---------|
| **Abuse reports** | [abuse@opaqueprotocol.org](mailto:abuse@opaqueprotocol.org) |
| **Security incidents** | [security@opaqueprotocol.org](mailto:security@opaqueprotocol.org) |
| **General support** | [GitHub Issues](https://github.com/collinsadi/opaque-stellar/issues) |
| **Production incidents (operators)** | See [RUNBOOK.md](./RUNBOOK.md) and [internal runbook](./internal/ABUSE_SANCTIONS_RUNBOOK.md) |

---

## 9. Policy updates

We may update this policy as the protocol or regulatory landscape changes. Material updates will be reflected in the repository and the in-app policy page.

_Last updated: 2026-05-29_
