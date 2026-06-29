# Privacy & GDPR Data Handling Appendix

This document clarifies data handling practices for Opaque Stellar, with particular attention to General Data Protection Regulation (GDPR) and similar privacy legislation.

## Overview

Opaque is designed to minimize personal data collection and processing. Most user data remains on the user's device, with no mandatory telemetry or tracking.

## Local Storage & Data Retention

### User-Controlled Data

The following data is stored **exclusively on the user's local device** and never transmitted to Opaque infrastructure:

- **Ghost key derivation:** Private keys and seed phrases used to generate ghost addresses
- **Local nullifier history:** Records of spent nullifiers for replay protection
- **Address book & contacts:** Cached mappings of payment links and ghost addresses
- **Wallet state:** Balance, transaction history, and account metadata
- **Cryptographic material:** User-specific proofs, witness data, and signing keys

**Responsibility:** Users are entirely responsible for backing up and securing this data. Lost local data cannot be recovered through on-chain mechanisms.

### Optional Telemetry Data

If opt-in telemetry is enabled by the user, the following is sent to Opaque servers:

- **Client version & environment:** OS, browser version, WASM runtime information
- **Feature usage events:** Which UI sections are accessed, which features are used (not what data is entered)
- **Anonymized performance metrics:** Proof generation time, network latency (no personal data)
- **Error traces:** Application crash reports (sanitized of user input)

**Transmission Security:** All telemetry is encrypted in transit (HTTPS) and deleted after 90 days.

**Default:** Telemetry is **disabled by default**. Users must explicitly opt-in at first run.

## Data Subject Rights (GDPR Articles 15-22)

If you have enabled telemetry and believe your personal data is being processed, you have the right to:

1. **Right of Access (Article 15):** Request a copy of any personal data Opaque holds about you.
2. **Right to Rectification (Article 16):** Request correction of inaccurate data.
3. **Right to Erasure (Article 17):** Request deletion of your data (subject to legal retention requirements).
4. **Right to Restrict Processing (Article 18):** Request that we limit how we use your data.
5. **Right to Data Portability (Article 20):** Request your data in a machine-readable format.
6. **Right to Object (Article 21):** Opt out of telemetry and profiling.

**How to Exercise These Rights:** Email privacy@opaque.ai with:
- Your request type (access, rectification, erasure, etc.)
- Your email address (if used with Opaque accounts)
- Any identifiers we may have logged (IP address, device ID, session token)

**Response Timeline:** We will respond within 30 days of receipt.

## Data Processors & Third Parties

Opaque does **not** sell user data to third parties. However, some data may be processed by:

- **Cloud Infrastructure Provider:** Telemetry and logs stored on encrypted servers (see DPA if available)
- **Analytics Platform:** Usage aggregation and error tracking (anonymized)
- **CDN Provider:** Static assets and no personal data

Users may request details of all data processors handling their information.

## On-Chain Data (Blockchain)

Once a transaction is broadcast to the Stellar blockchain, it becomes public and immutable. Opaque cannot delete or modify on-chain data. This includes:

- Payment recipient (ghost address), which obscures the recipient's identity
- Transaction amount and fees
- Timestamp and block height
- Nullifiers used for replay protection

Users should be aware that sophisticated chain analysis may correlate transactions over time.

## Cookies & Tracking

The Opaque frontend uses:

- **Session cookies:** Only to maintain authentication state (no tracking)
- **Local storage:** To cache user preferences (entirely client-side)
- **No third-party trackers:** Google Analytics, Facebook Pixel, etc. are not used

## Children's Privacy (COPPA / GDPR Article 8)

Opaque is not intended for users under 18. We do not knowingly collect data from children. If you believe a child has used Opaque, please notify privacy@opaque.ai.

## Policy Changes

This privacy policy may be updated as Opaque evolves. Changes will be reflected here and announced in release notes. Continued use of Opaque after a material change constitutes acceptance of the new terms.

---

**Last Updated:** 2026-06-28  
**Legal Review Status:** Pending legal counsel sign-off  

**For questions:** privacy@opaque.ai
