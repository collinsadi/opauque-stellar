# Deposit Exclusion & Appeal Process (#628)

This document describes the recourse available if your deposit is excluded from the approved set and answers to common questions about fund recovery.

## Understanding Exclusions

Deposits can be excluded from the Opaque approved set due to:
- **Compliance screening**: Addresses flagged by regulatory compliance checks
- **Policy violations**: Deposits that don't meet current inclusion criteria
- **Detection evasion attempts**: Transactions attempting to obscure intent

Exclusion does not destroy funds, but it does remove your ability to withdraw them on
your own. See [What exclusion does and does not do](#what-exclusion-does-and-does-not-do)
below before assuming you can simply withdraw.

## What exclusion does and does not do

An exclusion applies to a **privacy-pool deposit** — a note committed into the pool
tree — not to a balance sitting in a stealth address. The two have different
controlling keys:

| What you hold | Controlling key | Can you reach it while excluded? |
|:--------------|:----------------|:----------------------------------|
| Pooled deposit (note) | Note key | **No** — withdrawal needs a valid membership proof |
| Stealth account balance | Stealth / wallet key | Yes, independently of any pool exclusion |

A withdrawal from the pool requires a Groth16 membership proof built from a Merkle
path into the published association-set root. An excluded deposit index is omitted
from that set, so **no valid membership proof exists for it** and no withdrawal path
is available — not immediately, not after re-deriving keys, and not with a stale or
refreshed root. Stealth key derivation is irrelevant here: it recovers *stealth
addresses*, which never held the pooled deposit in the first place.

There is no operator-held key, escrow, or claim process that can return an excluded
deposit. **The only route back to your funds is reversing the exclusion** (Option 1
below). Until then the deposit is held in the pool but unspendable by you.

The flip side: an exclusion is not a loss of key material. If the exclusion is
reversed, the note is spendable again with the note key you already hold — provided
you still have it. Note keys are only recoverable from your own backup; there is no
server-side recovery path (see
[docs/SUPPORT_PLAYBOOK.md](SUPPORT_PLAYBOOK.md) and
[docs/KEY_MANAGEMENT_GUIDE.md](KEY_MANAGEMENT_GUIDE.md#backup-practices)).

## Recovery Options

### Option 1: Appeal for Inclusion Review

This is the only option that can return an excluded deposit to you. If the deposit
was excluded in error — or if the exclusion was a policy decision you can rebut —
the deposit must be restored to the approved set before any proof can be generated.

If you believe your deposit was wrongly excluded:
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
   - **Approved**: Deposit restored to approved set; a membership proof can be generated against the republished root and the note is spendable again
   - **Denied**: The deposit stays excluded and remains unspendable. There is no alternative withdrawal path — re-check your note-key backup, and see the appeal/audit references under [ASP Allowlist Exclusions](#asp-allowlist-exclusions)
   - **Escalation**: Senior review if you provide additional evidence

### Option 2: Bulk Disputes
If multiple deposits were excluded:

1. Contact operator with list of transaction hashes and a single narrative explaining the pattern
2. Bulk disputes are reviewed together with shared context
3. Individual appeals still processed in parallel

## Timing & Guarantees

| Action | Timeline | Guarantee |
|--------|----------|-----------|
| Withdrawing an **excluded** deposit | Not possible | No path exists while the deposit is outside the approved set |
| Appeal submission | Ongoing | None; best-effort review |
| Initial review response | 5–10 days | None; SLA TBD |
| Final decision | ≤30 days | None; depends on case complexity |
| Withdrawal after an approved appeal | Next ASP republish | None; depends on the note key still being available to you |

## After Exclusion: Proofs & Reputation

While your deposit is excluded:

- **Pool membership proofs**: Cannot be generated at all. The excluded index is not in the published association set, so there is no Merkle path to build a proof from. This is a missing-set condition, not a stale-root one — refreshing the root does not help.
- **Reputation**: Your credential attestations are unaffected; you can still prove reputation
- **Nullifiers**: Previous proofs remain valid; no replay risk
- **Stealth balances**: Unaffected — a private payment arriving in a stealth address is still yours to scan and sweep, independent of any pool exclusion

## Prevention

To minimize exclusion risk:

- **Use known addresses**: Stealth sends from established accounts reduce screening friction
- **Document context**: Large one-time sends are more likely to trigger review
- **Disclose intent**: If possible, communicate the use case (e.g., "custody transfer")
- **Batch deposits**: Multiple small deposits may attract more scrutiny than one large transfer

## Support

- **Bug or contract issue?** → Report in [GitHub Issues](https://github.com/collinsadi/opaque-stellar/issues)
- **Appeal status?** → Contact operator (see Option 1)
- **Lost a note key or wallet seed?** → [Backup practices](KEY_MANAGEMENT_GUIDE.md#backup-practices) and the [support playbook](SUPPORT_PLAYBOOK.md). There is no server-side recovery; only your own backup can restore a note key
- **Recovering a stealth address?** → [Key management guide](KEY_MANAGEMENT_GUIDE.md#stealth-key). Note this is *not* a route to an excluded pool deposit
- **Questions about the protocol?** → Read [README.md](../README.md)

---

**Version**: 1.1  
**Last updated**: 2026-09-26  
**Status**: Draft — operator contact details TBD

## ASP Allowlist Exclusions

When `ASP_POLICY=allowlist` is active, any finalized deposit index absent from the operator allowlist is rejected and omitted from the published association set. Operators should keep the allowlist source under change control and use the persisted `rejectedIndices` in `asp/data/state/<poolId>.json` as the appeal/audit reference.

If an appeal is accepted, run the operator command below against the ASP data directory. It removes the persisted rejection and adds the index to the approved set immediately; the next tick republishes the association-set root.

```sh
npm --prefix asp run asp:reinstate -- --pool-id <pool-id> --index <deposit-index> --data-dir <asp-data-dir> \
  --operator <name-or-ticket> --reason "<appeal reference>"
```

The command is deliberately limited to indices recorded as rejected and should be run under the operator's normal change-control process. The persisted policy decisions remain available for the audit trail, and every reinstatement appends its own `manual-reinstatement` approve decision recording `--operator` and `--reason`.

It is safe to run while the indexer is running. Both take the pool's state lock (`data/state/<pool-id>.json.lock`): the reinstatement waits for any in-flight tick to finish (default timeout 60s, `--lock-timeout-ms` to change it), and the next tick republishes the root with the deposit included. A lock left behind by a crashed process is reclaimed automatically once its PID is gone.
