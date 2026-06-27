/**
 * OperatorDashboard — Protocol health metrics for operators.
 *
 * Protected by an auth gate: the operator must have VITE_OPERATOR_SECRET stored
 * in localStorage under the key "opauque_operator_secret", matching the env var.
 * See frontend/docs/operator-dashboard.md for deploy instructions.
 */

import { useEffect, useMemo, useState } from "react";
import { useProtocolLog } from "../context/ProtocolLogContext";

// ---------------------------------------------------------------------------
// Auth gate helpers
// ---------------------------------------------------------------------------

const OPERATOR_SECRET_KEY = "opauque_operator_secret";

function getConfiguredSecret(): string {
  return (import.meta.env["VITE_OPERATOR_SECRET"] as string | undefined) ?? "";
}

function isOperatorAuthenticated(): boolean {
  const secret = getConfiguredSecret();
  if (!secret) return false;
  try {
    return localStorage.getItem(OPERATOR_SECRET_KEY) === secret;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Mock indexer lag — in a real deployment this would be fetched from an API
// ---------------------------------------------------------------------------

function useMockIndexerLag(): number {
  const [lag, setLag] = useState<number>(0);

  useEffect(() => {
    // Simulate a realistic lag between 0 and 5 ledgers; refreshes every 15 s
    const update = () => setLag(Math.floor(Math.random() * 6));
    update();
    const interval = setInterval(update, 15_000);
    return () => clearInterval(interval);
  }, []);

  return lag;
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(interval);
  }, [intervalMs]);

  return now;
}

// ---------------------------------------------------------------------------
// Announcement count over the past 24 h from ProtocolLogContext
// ---------------------------------------------------------------------------

const ONE_DAY_MS = 24 * 60 * 60 * 1_000;

function useAnnouncementCount(now: number): number {
  const { entries } = useProtocolLog();
  return useMemo(() => {
    const cutoff = now - ONE_DAY_MS;
    return entries.filter(
      (e) =>
        e.timestamp >= cutoff &&
        (e.message.toLowerCase().includes("announce") ||
          e.source === "blockchain"),
    ).length;
  }, [entries, now]);
}

// ---------------------------------------------------------------------------
// Proofs verified count (mock — derived from log entries mentioning "proof")
// ---------------------------------------------------------------------------

function useProofsVerified(now: number): number {
  const { entries } = useProtocolLog();
  return useMemo(() => {
    const cutoff = now - ONE_DAY_MS;
    return entries.filter(
      (e) =>
        e.timestamp >= cutoff &&
        e.message.toLowerCase().includes("proof"),
    ).length;
  }, [entries, now]);
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function OperatorDashboard() {
  const [isOperator, setIsOperator] = useState(() => isOperatorAuthenticated());
  const [secretInput, setSecretInput] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const now = useNow(60_000);

  const announcementCount = useAnnouncementCount(now);
  const indexerLag = useMockIndexerLag();
  const proofsVerified = useProofsVerified(now);
  const sparklineValues = useMemo(
    () => Array.from({ length: 12 }, (_, i) => (i === 11 ? indexerLag : (i * 3 + indexerLag) % 6)),
    [indexerLag],
  );

  const handleAuth = (e: React.FormEvent) => {
    e.preventDefault();
    const configured = getConfiguredSecret();
    if (!configured) {
      setAuthError("VITE_OPERATOR_SECRET is not configured on this deployment.");
      return;
    }
    if (secretInput === configured) {
      try {
        localStorage.setItem(OPERATOR_SECRET_KEY, secretInput);
      } catch {
        // localStorage may be blocked in private browsing; still allow session access
      }
      setIsOperator(true);
      setAuthError(null);
    } else {
      setAuthError("Incorrect operator secret.");
    }
  };

  if (!isOperator) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[40vh] px-4">
        <div className="w-full max-w-sm rounded-2xl border border-ink-700 bg-ink-900 p-6 space-y-4">
          <h2 className="text-base font-semibold text-white">Operator Access</h2>
          <p className="text-xs text-mist">
            Access restricted to operators. Enter the operator secret to continue.
          </p>
          <form onSubmit={handleAuth} className="space-y-3">
            <input
              type="password"
              value={secretInput}
              onChange={(e) => setSecretInput(e.target.value)}
              placeholder="Operator secret"
              className="w-full rounded-xl border border-ink-700 bg-ink-950 px-3 py-2.5 text-sm text-white placeholder-ink-500 focus:outline-none focus:border-white/40"
              autoComplete="current-password"
            />
            {authError && (
              <p className="text-xs text-red-400" role="alert">
                {authError}
              </p>
            )}
            <button
              type="submit"
              className="w-full rounded-xl bg-sol-gradient text-white text-sm font-semibold py-2.5 hover:opacity-90 border border-white transition-colors"
            >
              Authenticate
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="operator-dashboard max-w-2xl mx-auto py-8 px-4 space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white">Protocol Metrics (24h)</h2>
        <span className="text-[10px] text-mist border border-ink-700 rounded-full px-2.5 py-0.5">
          Operator view
        </span>
      </div>

      {/* Metric cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <MetricCard
          label="Announcements"
          value={announcementCount.toString()}
          description="On-chain stealth announcements in the last 24 h"
        />
        <MetricCard
          label="Indexer lag"
          value={`${indexerLag} ledger${indexerLag !== 1 ? "s" : ""}`}
          description="Ledgers behind the chain tip"
          highlight={indexerLag > 3 ? "warning" : "normal"}
        />
        <MetricCard
          label="Proofs verified"
          value={proofsVerified.toString()}
          description="ZK proof verifications logged in the last 24 h"
        />
      </div>

      {/* Indexer lag sparkline (textual) */}
      <div className="rounded-xl border border-ink-700 bg-ink-900/60 p-4">
        <p className="text-xs text-mist mb-2">Indexer lag — last reading</p>
        <div className="flex items-end gap-1 h-10">
          {sparklineValues.map((h, i) => {
            const pct = Math.max(8, (h / 5) * 100);
            return (
              <div
                key={i}
                className={`flex-1 rounded-sm ${h > 3 ? "bg-amber-500/60" : "bg-ink-700"}`}
                style={{ height: `${pct}%` }}
                title={`${h} ledgers`}
                aria-hidden
              />
            );
          })}
        </div>
        <p className="text-[10px] text-mist/60 mt-1">Simulated — connect indexer API for live data</p>
      </div>

      <button
        type="button"
        onClick={() => {
          try { localStorage.removeItem(OPERATOR_SECRET_KEY); } catch { /* ignore */ }
          setIsOperator(false);
        }}
        className="text-xs text-mist/60 hover:text-white transition-colors"
      >
        Sign out of operator view
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MetricCardProps {
  label: string;
  value: string;
  description: string;
  highlight?: "normal" | "warning";
}

function MetricCard({ label, value, description, highlight = "normal" }: MetricCardProps) {
  return (
    <div
      className={`rounded-xl border p-4 space-y-1 ${
        highlight === "warning"
          ? "border-amber-500/40 bg-amber-500/5"
          : "border-ink-700 bg-ink-900/60"
      }`}
    >
      <p className="text-[10px] text-mist uppercase tracking-wide">{label}</p>
      <p
        className={`text-2xl font-bold ${
          highlight === "warning" ? "text-amber-300" : "text-white"
        }`}
      >
        {value}
      </p>
      <p className="text-[10px] text-mist/60">{description}</p>
    </div>
  );
}
