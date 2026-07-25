# Deposit Exclusion & Appeal Process (#628)

This document describes the recourse available if your deposit is excluded from the approved set and answers to common questions about fund recovery.

## Understanding Exclusions

Deposits can be excluded from the Opaque approved set due to:
- **Compliance screening**: Addresses flagged by regulatory compliance checks
- **Policy violations**: Deposits that don't meet current inclusion criteria
- **Detection evasion attempts**: Transactions attempting to obscure intent

Excluded funds are **not lost** — they remain under your control via your stealth keys.

## Recovery Options

### Option 1: Direct Withdrawal (Self-Custody)
Your funds are always accessible via stealth key derivation:

1. Go to your wallet's **Stealth Keys** section
2. Navigate to **View Master Keys** → export your recovery seed
3. Use the DKSAP derivation with your master keys to recover the ephemeral account
4. Transfer funds to your main wallet address
5. [Detailed stealth recovery guide](frontend/README.md#recovery)

**Timeline**: Immediate (same ledger)  
**Trust model**: Self-custody — no operator involvement

### Option 2: Appeal for Inclusion Review
If you believe your deposit was wrongly excluded:

1. **Gather evidence**:
   - Transaction hash and timestamp
   - Source and destination addresses (both public and stealth)
   - Intended use case (payment, custody, other)
   - Any relevant documentation (invoice, proof of legitimacy, etc.)

2. **Submit appeal**:
   - Email: [operator-contact@opaque.example.com] (placeholder)
   - Include: "APPEAL: Deposit {tx_hash}" in subject
   - Provide all evidence from step 1
   - Clearly explain why the exclusion was incorrect

3. **Review timeline**:
   - Initial review: 5–10 business days
   - Investigation: Up to 30 days for complex cases
   - Decision notification: Email with outcome

4. **Possible outcomes**:
   - **Approved**: Deposit restored to approved set; proof generation succeeds
   - **Denied**: Withdrawal remains only option (see Option 1)
   - **Escalation**: Senior review if you provide additional evidence

### Option 3: Bulk Disputes
If multiple deposits were excluded:

1. Contact operator with list of transaction hashes and a single narrative explaining the pattern
2. Bulk disputes are reviewed together with shared context
3. Individual appeals still processed in parallel

## Timing & Guarantees

| Action | Timeline | Guarantee |
|--------|----------|-----------|
| Self-withdrawal via stealth keys | Immediate | ✓ No permission needed |
| Appeal submission | Ongoing | None; best-effort review |
| Initial review response | 5–10 days | None; SLA TBD |
| Final decision | ≤30 days | None; depends on case complexity |

## After Exclusion: Proofs & Reputation

While your deposit is excluded:

- **Proof generation**: Fails with "root not fresh" or similar if using stale data
- **Reputation**: Your credential attestations are unaffected; you can still prove reputation
- **Nullifiers**: Previous proofs remain valid; no replay risk

## Prevention

To minimize exclusion risk:

- **Use known addresses**: Stealth sends from established accounts reduce screening friction
- **Document context**: Large one-time sends are more likely to trigger review
- **Disclose intent**: If possible, communicate the use case (e.g., "custody transfer")
- **Batch deposits**: Multiple small deposits may attract more scrutiny than one large transfer

## Support

- **Bug or contract issue?** → Report in [GitHub Issues](https://github.com/collinsadi/opauque-stellar/issues)
- **Appeal status?** → Contact operator (see Option 2)
- **How to withdraw via keys?** → [Stealth recovery guide](frontend/README.md#recovery)
- **Questions about the protocol?** → Read [README.md](../README.md)

---

**Version**: 1.0  
**Last updated**: 2026-07-25  
**Status**: Draft — operator contact details TBD
