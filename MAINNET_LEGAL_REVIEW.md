# Mainnet Legal Review — Privacy Payment Use

This document records the legal and compliance review required before enabling Opaque privacy payment tooling on Stellar mainnet with real funds.

## Scope

Mainnet privacy tooling includes:

- Stealth (DKSAP) send and receive of native XLM
- Private balance scanning and sweep
- Payment links (`/pay/:identifier`)
- Soroban contract interactions (stealth registry, stealth announcer)

These features may trigger regulatory, sanctions, or compliance obligations depending on jurisdiction and use case.

## Documents reviewed

| Document | Location | Mainnet updates |
|----------|----------|-----------------|
| Terms of Service | `frontend/src/components/TermsPage.tsx` | Mainnet use, acceptable use, jurisdictional restrictions |
| Privacy Policy | `frontend/src/components/PrivacyPage.tsx` | Mainnet privacy limits, on-chain linkability |
| Disclaimer | `frontend/src/components/DisclaimerPage.tsx`, `DISCLAIMER.md` | Production risks, no audit warranty, real funds |
| In-app legal gate | `frontend/src/components/security/MainnetWarningModal.tsx` | Links legal docs before first mainnet use |

## Risk acceptance

The following risks are accepted for mainnet privacy payment use:

1. **Regulatory exposure.** Privacy-preserving payment tools may be restricted or require licensing in some jurisdictions. Users are responsible for determining legality in their location.
2. **Sanctions and AML.** Opaque is non-custodial and does not screen counterparties. Users must comply with applicable sanctions lists and anti–money laundering obligations.
3. **Real funds at risk.** Mainnet XLM has monetary value. Account creation reserves, fees, and failed transactions consume real assets irreversibly.
4. **Incomplete privacy.** Stealth addresses reduce linkability but do not eliminate metadata analysis, timing correlation, or off-chain deanonymization.
5. **Experimental software.** Contracts and frontend are not formally audited for production. Bugs may cause loss of funds or access.
6. **App store and domain policies.** Distribution channels (browser, app stores, custom domains) may impose additional acceptable-use or financial-service restrictions independent of the protocol.

## User acceptance flow

Before any mainnet session, the app requires users to:

1. Review linked Terms of Service, Privacy Policy, and Disclaimer
2. Confirm they understand mainnet transactions use real funds
3. Persist acknowledgment in local storage (`opaque-security-settings`)

Acknowledgment is per-browser and does not constitute legal advice or a waiver of applicable law.

## Deployment checklist

- [ ] Terms, Privacy, and Disclaimer updated for mainnet (see legal page components)
- [ ] This risk acceptance document committed and reviewed
- [ ] Mainnet legal gate active (`MainnetWarningModal` with legal doc links)
- [ ] Production RPC and contract IDs validated via release workflow
- [ ] App store / domain acceptable-use policies reviewed for target distribution

## Review status

| Item | Status | Notes |
|------|--------|-------|
| Legal docs updated for mainnet | Done | UI pages and `DISCLAIMER.md` |
| Risk acceptance documented | Done | This file |
| App links legal docs before first mainnet use | Done | `MainnetWarningModal` + `MainnetSecurityLayer` |

_Last updated: 2026-05-29_
