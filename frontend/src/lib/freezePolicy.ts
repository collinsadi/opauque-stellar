/**
 * Emergency freeze policy for reputation roots.
 *
 * A compromised root publisher could authorize false claims until manually stopped.
 * The freeze is multisig-controlled. When the root is frozen the UI blocks proof
 * verification and displays a prominent warning.
 *
 * Related: Issue #85 (emergency freeze policy for reputation roots).
 */

export type FreezeStatus =
  /** Normal operation — root is live and recently updated. */
  | "active"
  /** Governance has frozen root updates; proof verification is blocked. */
  | "frozen"
  /**
   * Root has not been updated within STALE_ROOT_THRESHOLD_LEDGERS.
   * Proofs may still succeed but the staleness warning is shown.
   */
  | "stale"
  /** Contract did not respond or freeze() is not yet implemented. */
  | "unknown";

export interface FreezeInfo {
  status: FreezeStatus;
  /** Ledger sequence when the freeze was applied (if frozen). */
  frozenAtLedger?: number;
  /** Ledger sequence of the last root update (to detect staleness). */
  lastRootUpdateLedger?: number;
  currentLedger?: number;
}

/**
 * Roots older than this many ledgers (~1 day at ~5 s/ledger on Testnet)
 * are considered stale and surface an amber warning in the UI.
 */
export const STALE_ROOT_THRESHOLD_LEDGERS = 17_280;

export function computeFreezeStatus(info: {
  isFrozen: boolean;
  lastRootUpdateLedger?: number;
  currentLedger?: number;
}): FreezeStatus {
  if (info.isFrozen) return "frozen";
  if (
    info.lastRootUpdateLedger !== undefined &&
    info.currentLedger !== undefined &&
    info.currentLedger - info.lastRootUpdateLedger > STALE_ROOT_THRESHOLD_LEDGERS
  ) {
    return "stale";
  }
  return "active";
}

/**
 * Human-readable summary for each freeze status shown in the UI.
 */
export const FREEZE_STATUS_COPY: Record<FreezeStatus, { title: string; detail: string }> = {
  active: {
    title: "Verification Active",
    detail: "Reputation root is live and recently updated. Proofs can be generated normally.",
  },
  frozen: {
    title: "Root Frozen — Proof Generation Blocked",
    detail:
      "Governance has frozen the reputation root due to a suspected incident. " +
      "Proof generation and verification are disabled until the freeze is lifted.",
  },
  stale: {
    title: "Root Stale",
    detail:
      "The reputation root has not been updated recently. " +
      "Proofs may still succeed but could reference outdated state.",
  },
  unknown: {
    title: "Status Unknown",
    detail: "Could not read freeze status from the contract. Connect your wallet to check.",
  },
};

/**
 * Incident runbook exposed to operators via the Admin panel.
 * Acceptance criterion: runbook is documented (Issue #85).
 */
export const FREEZE_INCIDENT_RUNBOOK = `# Emergency Freeze Runbook

## When to freeze
- Root publisher key is suspected compromised
- Proof verification is returning false positives
- Critical vulnerability discovered in the attestation engine

## Freeze procedure (multisig-controlled)
1. Gather signatures from all key holders meeting the multisig threshold (≥ 2/3).
2. Build a Stellar transaction calling \`freeze_roots()\` on the reputation root contract.
3. Collect signatures from the required co-signers using Stellar Laboratory or your HSM tool.
4. Broadcast the multisig transaction.
5. Confirm the contract state reflects \`is_frozen = true\`.
6. Communicate the incident and ETA for resolution to affected parties.

## Unfreeze procedure
1. Identify and resolve the root cause (rotate compromised keys, patch the vulnerability).
2. Publish a new valid reputation root via the authorised publisher multisig.
3. Build and broadcast a multisig transaction calling \`unfreeze_roots()\`.
4. Verify \`is_frozen = false\` and that the new root is accepted by the verifier.

## Multisig key management
- Each signer must use a separate hardware wallet (Ledger/Trezor).
- Configure the admin Stellar account with:
  - \`med_threshold ≥ 2\` for freeze/unfreeze operations.
  - \`high_threshold = total_signers\` for key rotation.
- Rotate signer keys annually or immediately after any suspected compromise.
- Document all signers and thresholds in the internal secrets vault.`.trim();
