# Wave-2 Roadmap

> This document outlines planned themes and rough quarters for wave-2 development. It complements the [GitHub issues](https://github.com/collinsadi/opauque-stellar/issues) and is updated when major scope shifts.

---

## Themes

### Multi-asset support (Q3 2026)

Extend stealth payments beyond native XLM to Stellar assets (USDC, issued tokens).

- Asset-aware announcement payloads
- Trustline discovery and auto-funding for recipients
- Frontend asset picker with balance display
- **Related issues:** #151+

### Wallet ecosystem (Q3–Q4 2026)

Broaden wallet support beyond Freighter.

- Lobstr Wallet adapter (SEP-7 / WalletConnect)
- Ledger hardware wallet for key management
- Magic wallet (email/social) onboarding path
- **Related issues:** #151+

### Indexer & notifications (Q4 2026)

Replace polling-based scanning with a push indexer.

- Off-chain indexer service (event streaming)
- WebSocket notifications for incoming stealth payments
- Mobile push notifications via Firebase
- **Related issues:** #151+

### v3 circuits (Q1 2027)

Next-generation ZK circuits with improved constraints and features.

- Recursive proof composition
- Batch nullifier checks
- Reduced proving time via optimized Circom
- **Related issues:** #151+

---

## Non-goals (explicitly out of scope for wave-2)

| Theme | Rationale |
|:------|:----------|
| **Solana bridge** | Cross-chain integration deferred to wave-3; no Solana → Stellar messaging in this wave. |
| **NFT stealth drops** | Requires new Soroban contract standards; not planned until v3 circuits land. |
| **Mobile native app** | The web wallet remains the primary target; no React Native or Swift/Kotlin re-write. |
| **KYC/gated attestations** | Attestation engine remains permissionless; no identity-verification layer. |

---

## Scope changes

This roadmap is a living document. When a major shift occurs (e.g., new contract version, deprecation of a theme), this file is updated with the change and rationale. Minor scope adjustments within a theme are tracked in the relevant GitHub issue.

---

See [README.md](README.md) for the current feature set and quick-start instructions.
