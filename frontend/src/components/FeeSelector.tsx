"use client";

/**
 * FeeSelector: shows estimated fees before signing and lets the user pick
 * a fee tier (issue #1137). Displays network congestion status and caps.
 */

import { useState, useEffect } from "react";
import { estimateFees, type FeeEstimate, type NetworkFeeConditions, getNetworkFeeConditions } from "../lib/feeEstimation";
import { Zap, AlertTriangle } from "lucide-react";

interface FeeSelectorProps {
  selectedFee: string | null;
  onSelectFee: (feeStroops: string) => void;
}

export function FeeSelector({ selectedFee, onSelectFee }: FeeSelectorProps) {
  const [fees, setFees] = useState<FeeEstimate[]>([]);
  const [conditions, setConditions] = useState<NetworkFeeConditions | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      const [feeEstimates, feeConditions] = await Promise.all([
        estimateFees(),
        getNetworkFeeConditions(),
      ]);
      if (!cancelled) {
        setFees(feeEstimates);
        setConditions(feeConditions);
        // Auto-select standard fee
        if (!selectedFee && feeEstimates.length > 1) {
          onSelectFee(feeEstimates[1].feeStroops);
        }
        setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) {
    return (
      <div className="animate-pulse h-24 rounded-xl border border-ink-700 bg-ink-800" />
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="text-xs font-medium text-ink-300 flex items-center gap-1.5">
          <Zap className="w-3.5 h-3.5" />
          Transaction Fee
        </label>
        {conditions?.isCongested && (
          <span className="inline-flex items-center gap-1 text-xs text-amber-400">
            <AlertTriangle className="w-3 h-3" />
            Network congested
          </span>
        )}
      </div>

      <div className="grid grid-cols-3 gap-2">
        {fees.map((fee) => (
          <button
            key={fee.label}
            type="button"
            onClick={() => onSelectFee(fee.feeStroops)}
            className={`rounded-xl border px-3 py-2.5 text-left transition-colors ${
              selectedFee === fee.feeStroops
                ? "border-white bg-ink-700"
                : "border-ink-700 bg-ink-800 hover:border-ink-500"
            }`}
          >
            <p className="text-xs font-medium text-white">{fee.label}</p>
            <p className="text-xs text-ink-400 mt-0.5">
              {(Number(fee.feeStroops) / 1e7).toFixed(4)} XLM
            </p>
            {fee.congestionNote && (
              <p className="text-[10px] text-amber-400/80 mt-1 leading-tight">
                {fee.congestionNote}
              </p>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
