import { useEffect, useState } from "react";
import { getCluster } from "../lib/chain";
import { getExplorerTxUrl } from "../lib/explorer";
import { useTxHistoryStore } from "../store/txHistoryStore";
import type { TxHistoryEntry } from "../store/txHistoryStore";
import { useGhostAddressStore } from "../store/ghostAddressStore";
import { useWallet } from "../hooks/useWallet";
import { formatXlmFromStroops, formatDateTime } from "../lib/i18n-format";
import { reconcileFromChain } from "../lib/history-reconciliation";
import type { ReconciledEntry } from "../lib/history-reconciliation";
import { fetchHorizonHistory } from "../services/stellarClient";

function typeLabel(kind: TxHistoryEntry["kind"]): string {
  switch (kind) {
    case "sent":
      return "Sent";
    case "received":
      return "Received";
    case "ghost":
      return "Manual";
    case "trait":
      return "Trait";
    default:
      return String(kind);
  }
}

function statusFor(entry: TxHistoryEntry): string {
  return entry.txHash ? "Confirmed" : "—";
}

/** Token symbol badge for list display (icon-style: symbol only). */
function TokenBadge({ symbol }: { symbol: string }) {
  return (
    <span
      className="inline-flex items-center justify-center min-w-9 px-1.5 py-0.5 rounded-lg font-mono text-xs font-medium bg-ink-900/60 text-mist border border-ink-700"
      title={symbol}
    >
      {symbol}
    </span>
  );
}

function normalizeEntry(raw: unknown, index: number): TxHistoryEntry | null {
  if (raw == null || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === "string" ? o.id : `tx-fallback-${index}`;
  const cluster = typeof o.cluster === "string" ? o.cluster : getCluster();
  const kind =
    o.kind === "sent" ||
    o.kind === "received" ||
    o.kind === "ghost" ||
    o.kind === "trait"
      ? o.kind
      : "sent";
  const counterparty =
    typeof o.counterparty === "string" ? o.counterparty : "—";
  const amountStroops =
    typeof o.amountStroops === "string"
      ? o.amountStroops
      : typeof o.amountLamports === "string"
        ? o.amountLamports
        : "0";
  const txHash = typeof o.txHash === "string" ? o.txHash : undefined;
  const stealthAddress =
    typeof o.stealthAddress === "string" ? o.stealthAddress : undefined;
  const timestamp = typeof o.timestamp === "number" ? o.timestamp : Date.now();
  const tokenSymbol = typeof o.tokenSymbol === "string" ? o.tokenSymbol : "XLM";
  const tokenAddress =
    o.tokenAddress != null && typeof o.tokenAddress === "string"
      ? (o.tokenAddress as TxHistoryEntry["tokenAddress"])
      : null;
  const amount =
    typeof o.amount === "string" && o.amount !== ""
      ? o.amount
      : formatXlmFromStroops(BigInt(amountStroops || "0"));
  return {
    id,
    cluster,
    kind,
    counterparty,
    amountStroops,
    tokenSymbol,
    tokenAddress,
    amount,
    txHash,
    stealthAddress,
    timestamp,
  };
}

function ChainStatusBadge({ entry }: { entry: TxHistoryEntry | ReconciledEntry }) {
  if (!("chainStatus" in entry)) return null;
  const { chainStatus } = entry as ReconciledEntry;
  if (chainStatus === "failed") {
    return (
      <span className="inline-flex px-2 py-0.5 rounded-lg text-[11px] font-medium bg-neutral-500/10 text-neutral-400 border border-neutral-500/20">
        Failed
      </span>
    );
  }
  if (chainStatus === "pending") {
    return (
      <span className="inline-flex px-2 py-0.5 rounded-lg text-[11px] font-medium bg-neutral-400/10 text-neutral-300 border border-neutral-400/20">
        Pending
      </span>
    );
  }
  return null;
}

export function TransactionHistoryView() {
  const { cluster: walletCluster } = useWallet();
  const cluster = walletCluster ?? getCluster();
  const byCluster = useTxHistoryStore((s) => s.byChain);
  const clear = useTxHistoryStore((s) => s.clear);

  const [reconciling, setReconciling] = useState(false);
  const [reconciledEntries, setReconciledEntries] = useState<ReconciledEntry[] | null>(null);

  let entries: TxHistoryEntry[] = [];
  try {
    const raw = byCluster[cluster] ?? [];
    const arr = Array.isArray(raw) ? raw : [];
    entries = (arr ?? [])
      .map((item: unknown, i: number) => normalizeEntry(item, i))
      .filter((e): e is TxHistoryEntry => e != null);
  } catch {
    entries = [];
  }
  const safeEntries = Array.isArray(entries) ? entries : [];

  useEffect(() => {
    const ghostAddresses = useGhostAddressStore
      .getState()
      .getForCluster(cluster)
      .map((e) => e.stealthAddress);
    const local = useTxHistoryStore.getState().getForCluster(cluster);
    setReconciling(true);
    reconcileFromChain(fetchHorizonHistory, { local, cluster, ghostAddresses })
      .then((result) => setReconciledEntries(result.entries))
      .catch(() => {
        // Fall back to local history on Horizon errors
      })
      .finally(() => setReconciling(false));
  }, [cluster]);

  const displayEntries = reconciledEntries ?? safeEntries;

  const handleClear = () => {
    if (
      typeof window !== "undefined" &&
      window.confirm("Clear all transaction history? This cannot be undone.")
    ) {
      clear();
      setReconciledEntries(null);
    }
  };

  return (
    <div className="w-full">
      <div className="mb-8">
        <h2 className="font-display text-2xl font-bold text-white">History</h2>
        <p className="mt-1 text-sm text-mist">
          Last 50 transactions on this network, including private sends,
          withdrawals, and traits.
        </p>
        {reconciling && (
          <p className="mt-1 text-xs text-mist/70">Syncing on-chain history…</p>
        )}
      </div>

      {!displayEntries?.length ? (
        <div className="rounded-3xl border border-ink-700 bg-ink-900/25 p-10 text-center">
          <div className="text-3xl mb-3" aria-hidden>
            ◈
          </div>
          <h3 className="font-display text-lg font-bold text-white mb-1">
            No history yet
          </h3>
          <p className="text-sm text-mist max-w-sm mx-auto">
            When you send privately, withdraw from stealth addresses, or issue
            traits, entries will appear here.
          </p>
        </div>
      ) : (
        <>
          <ul className="space-y-3">
            {displayEntries.map((tx) => (
              <li
                key={tx?.id ?? `tx-${tx?.timestamp ?? 0}`}
                className="rounded-2xl border border-ink-700 bg-ink-900/25 p-4 transition-colors hover:border-white/25"
              >
                <div className="flex flex-wrap items-start gap-3">
                  <span className="text-mist/80 text-xs shrink-0 font-mono">
                    {formatDateTime(tx.timestamp, { dateStyle: "short", timeStyle: "short" })}
                  </span>
                  <span
                    className={`inline-flex px-2 py-0.5 rounded-lg text-[11px] font-medium shrink-0 ${
                      tx.kind === "sent"
                        ? "bg-ink-800 text-mist"
                        : tx.kind === "received"
                          ? "bg-success/15 text-success"
                          : tx.kind === "trait"
                            ? "bg-neutral-400/15 text-neutral-300"
                            : "bg-neutral-500/15 text-neutral-400"
                    }`}
                  >
                    {typeLabel(tx.kind)}
                  </span>
                  <span className="text-mist/70 text-xs shrink-0">
                    {statusFor(tx)}
                  </span>
                  <ChainStatusBadge entry={tx} />
                  <span
                    className="text-mist text-xs truncate min-w-0 ml-auto"
                    title={tx.counterparty ?? ""}
                  >
                    {tx.counterparty ?? "—"}
                  </span>
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-2 text-white">
                  {tx.kind === "trait" ? (
                    <span className="text-sm font-medium">{tx.amount}</span>
                  ) : (
                    <>
                      <TokenBadge symbol={tx.tokenSymbol} />
                      <span className="font-mono text-sm">
                        {tx.amount} {tx.tokenSymbol}
                      </span>
                    </>
                  )}
                </div>

                {tx.txHash &&
                  (() => {
                    const explorerUrl = getExplorerTxUrl(tx.txHash);
                    return explorerUrl ? (
                      <a
                        href={explorerUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-3 inline-flex items-center gap-1 text-xs text-mist/80 hover:text-white transition-colors"
                        title={tx.txHash}
                      >
                        View on explorer ↗
                      </a>
                    ) : null;
                  })()}
              </li>
            ))}
          </ul>

          <button
            type="button"
            onClick={handleClear}
            className="mt-5 rounded-xl border border-ink-600 bg-ink-950/30 px-4 py-2 text-sm font-medium text-mist transition-colors hover:border-white/30 hover:text-white"
          >
            Clear history
          </button>
        </>
      )}
    </div>
  );
}
