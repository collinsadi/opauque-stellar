"use client";

/**
 * FeeBumpButton: allows users to fee-bump a stuck pending transaction
 * from the pending/transaction view (issue #1137).
 */

import { useState } from "react";
import { type Transaction, type FeeBumpTransaction } from "@stellar/stellar-sdk";
import { buildFeeBumpTransaction, getSuggestedFeeBump } from "../lib/feeEstimation";
import { Rocket, Loader2 } from "lucide-react";

interface FeeBumpButtonProps {
  tx: Transaction | FeeBumpTransaction;
  feeAccountPublicKey: string;
  onSigned: (feeBumpTx: FeeBumpTransaction) => Promise<void>;
  disabled?: boolean;
}

export function FeeBumpButton({
  tx,
  feeAccountPublicKey,
  onSigned,
  disabled,
}: FeeBumpButtonProps) {
  const [bumping, setBumping] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const suggestedFee = getSuggestedFeeBump(tx.fee);

  const handleBump = async () => {
    setBumping(true);
    try {
      const feeBumpTx = buildFeeBumpTransaction(tx, feeAccountPublicKey, suggestedFee);
      await onSigned(feeBumpTx);
    } finally {
      setBumping(false);
      setShowConfirm(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setShowConfirm(true)}
        disabled={disabled || bumping}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-amber-400 border border-amber-500/30 hover:bg-amber-500/10 rounded-lg transition-colors disabled:opacity-40"
      >
        {bumping ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : (
          <Rocket className="w-3.5 h-3.5" />
        )}
        Fee Bump
      </button>

      {showConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="bg-ink-900 border border-ink-700 rounded-2xl p-6 max-w-sm w-full mx-4">
            <h3 className="text-sm font-semibold text-white mb-2">
              Accelerate transaction
            </h3>
            <p className="text-xs text-ink-400 mb-4">
              This will submit a fee-bump transaction with a higher fee to speed up
              inclusion. The new fee is {(Number(suggestedFee) / 1e7).toFixed(4)} XLM.
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setShowConfirm(false)}
                className="flex-1 px-3 py-2 text-xs font-medium text-ink-300 border border-ink-700 rounded-lg hover:bg-ink-800 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => void handleBump()}
                disabled={bumping}
                className="flex-1 px-3 py-2 text-xs font-medium text-white bg-amber-600 hover:bg-amber-500 rounded-lg transition-colors disabled:opacity-50"
              >
                {bumping ? "Bumping..." : "Confirm Fee Bump"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
