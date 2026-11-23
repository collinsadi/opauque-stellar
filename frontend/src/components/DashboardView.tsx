import { useEffect, useState } from "react";
import { FiInbox } from "react-icons/fi";
import type { Tab } from "./Layout";
import { ExplorerLink } from "./ExplorerLink";
import { isClusterSupported } from "../contracts/contract-config";
import { SwitchNetworkModal } from "./SwitchNetworkModal";
import { getCluster } from "../lib/chain";
import type { StellarNetwork } from "../lib/chain";
import { maskCounterparty, useTxHistoryStore } from "../store/txHistoryStore";
import type { TxHistoryEntry } from "../store/txHistoryStore";
import { isTabNavVisible } from "../lib/tabAccess";
import { getFeatureFlags } from "../lib/featureFlags";
import { getHorizonServer } from "../lib/stellar";
import { parseHorizonBalanceToStroops } from "../lib/decimalParser";
import { formatXlm } from "../lib/stealth";
import { unspentTotal } from "../lib/poolNotes";
import { getPoolConfig } from "../contracts/poolConfig";
import { useVaultStore } from "../store/vaultStore";
import { usePoolNoteStore } from "../store/poolNoteStore";

type DashboardViewProps = {
  onNavigate: (t: Tab) => void;
  address?: string;
  cluster: string | null;
};

const ACTION_CARDS: {
  id: Tab;
  icon: string;
  title: string;
  subtitle: string;
  accent: "glow" | "flare" | "mist";
}[] = [
  {
    id: "send",
    icon: "↑",
    title: "Send",
    subtitle: "Send XLM to a registered address or meta-address",
    accent: "glow",
  },
  {
    id: "receive",
    icon: "↓",
    title: "Receive",
    subtitle: "Payment link or manual ghost address",
    accent: "glow",
  },
];

const QUICK_LINKS: { id: Tab; label: string }[] = [
  { id: "balance" as Tab, label: "Private balance" },
  { id: "pool" as Tab, label: "Privacy pool" },
  { id: "history" as Tab, label: "History" },
  { id: "reputation" as Tab, label: "My Traits" },
  { id: "manage" as Tab, label: "Manage" },
].filter((link) => isTabNavVisible(link.id));

type WalletBalance =
  | { status: "loading" }
  | { status: "ok"; stroops: bigint }
  | { status: "unfunded" }
  | { status: "error" };

/** Native XLM balance of the connected wallet, fetched from Horizon. */
function useWalletBalance(address: string | undefined, cluster: string | null): WalletBalance | null {
  const [balance, setBalance] = useState<WalletBalance | null>(null);

  useEffect(() => {
    if (!address) {
      setBalance(null);
      return;
    }
    let cancelled = false;
    setBalance({ status: "loading" });
    getHorizonServer()
      .loadAccount(address)
      .then((account) => {
        if (cancelled) return;
        const native = account.balances.find((b) => b.asset_type === "native") as
          | { balance: string }
          | undefined;
        setBalance({ status: "ok", stroops: parseHorizonBalanceToStroops(native?.balance) });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const status = (err as { response?: { status?: number } })?.response?.status;
        setBalance(status === 404 ? { status: "unfunded" } : { status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [address, cluster]);

  return balance;
}

export function DashboardView({ onNavigate, address, cluster }: DashboardViewProps) {
  const [showSwitchModal, setShowSwitchModal] = useState(false);
  const manualGhostEnabled = getFeatureFlags().manualGhostAddresses;

  const receiveSubtitle = manualGhostEnabled
    ? "Payment link or manual ghost address"
    : "Payment link";

  const canChangeNetwork = cluster != null && isClusterSupported(cluster as StellarNetwork);
  const byChain = useTxHistoryStore((s) => s.byChain);
  const walletBalance = useWalletBalance(address, cluster);
  const vaultEntries = useVaultStore((s) => s.entries);
  const stealthEntries = vaultEntries.filter((e) => !e.isSpent);
  const stealthTotal = stealthEntries.reduce((sum, e) => sum + e.amountStroops, 0n);
  const poolId = cluster != null ? getPoolConfig()?.poolId : undefined;
  // #1103: read pool notes through the account-scoped selector so the
  // dashboard only sums the active account's notes, not all accounts'.
  const unspentPoolNotes = usePoolNoteStore((s) =>
    cluster == null
      ? []
      : s.getForCluster(cluster).filter((n) => !n.spent && (!n.poolId || n.poolId === poolId)),
  );
  const poolTotal = unspentTotal(unspentPoolNotes);

  const walletValue =
    walletBalance == null
      ? "-"
      : walletBalance.status === "loading"
        ? "…"
        : walletBalance.status === "ok"
          ? `${formatXlm(walletBalance.stroops)} XLM`
          : walletBalance.status === "unfunded"
            ? "0 XLM"
            : "Unavailable";

  const balanceCards: { id?: Tab; label: string; value: string; hint: string }[] = [
    {
      label: "Wallet",
      value: walletValue,
      hint: walletBalance?.status === "unfunded" ? "Account not funded" : "Public XLM balance",
    },
    {
      id: "balance" as Tab,
      label: "Stealth",
      value: `${formatXlm(stealthTotal)} XLM`,
      hint: `${stealthEntries.length} address${stealthEntries.length === 1 ? "" : "es"} · as of last scan`,
    },
    {
      id: "pool" as Tab,
      label: "Privacy pool",
      value: `${formatXlm(poolTotal)} XLM`,
      hint: `${unspentPoolNotes.length} unspent note${unspentPoolNotes.length === 1 ? "" : "s"}`,
    },
  ];

  const recentHistory: TxHistoryEntry[] = cluster != null ? (byChain[cluster] ?? []).slice(0, 4) : [];

  const formatDate = (ts: number): string => {
    try {
      return new Date(ts).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
    } catch {
      return "-";
    }
  };

  return (
    <div className="w-full">
      {/* ── Header row ── */}
      <div className="mb-8">
        <div className="flex flex-wrap items-center gap-3 mb-1">
          <h2 className="font-display text-2xl font-bold text-white">Dashboard</h2>
          {address && (
            <ExplorerLink
              cluster={cluster}
              value={address}
              type="address"
              copyOnAddressClick
              className="shrink-0 text-mist"
            />
          )}
        </div>
        {canChangeNetwork && (
          <div className="mt-2 flex items-center gap-3">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-ink-600 bg-ink-900/40 px-3 py-1 text-xs text-mist">
              <span className="h-1.5 w-1.5 rounded-full bg-glow" aria-hidden />
              {getCluster()}
            </span>
            <button
              type="button"
              onClick={() => setShowSwitchModal(true)}
              className="text-xs text-mist/70 hover:text-white transition-colors"
            >
              Switch
            </button>
          </div>
        )}
      </div>

      {/* ── Balance summary ── */}
      <section className="mb-6" aria-label="Balance summary">
        <div className="grid gap-3 sm:grid-cols-3">
          {balanceCards.map((card) => {
            const target = card.id != null && isTabNavVisible(card.id) ? card.id : null;
            const content = (
              <>
                <p className="text-xs font-semibold uppercase tracking-widest text-mist/70">{card.label}</p>
                <p className="mt-1 truncate font-display text-xl font-bold text-white" title={card.value}>
                  {card.value}
                </p>
                <p className="mt-1 text-xs text-mist/60">{card.hint}</p>
              </>
            );
            const className =
              "rounded-2xl border border-ink-600 bg-ink-900/25 px-5 py-4 text-left";
            return target ? (
              <button
                key={card.label}
                type="button"
                onClick={() => onNavigate(target)}
                className={`${className} transition-colors hover:border-glow/40`}
              >
                {content}
              </button>
            ) : (
              <div key={card.label} className={className}>
                {content}
              </div>
            );
          })}
        </div>
      </section>

      {/* ── Primary action cards ── */}
      <div className="grid gap-4 sm:grid-cols-2">
        {ACTION_CARDS.map((card) => (
          <button
            key={card.id}
            type="button"
            onClick={() => onNavigate(card.id)}
            data-tour={card.id === "receive" ? "receive" : undefined}
            className="group relative overflow-hidden rounded-2xl border border-ink-600 bg-ink-900/25 p-6 text-left transition-colors hover:border-glow/40"
          >
            <span
              className={`mb-4 flex h-10 w-10 items-center justify-center rounded-xl text-lg ${
                card.accent === "flare"
                  ? "bg-flare/15 text-flare"
                  : card.accent === "mist"
                    ? "bg-ink-700/60 text-mist"
                    : "bg-glow-muted/30 text-glow"
              }`}
              aria-hidden
            >
              {card.icon}
            </span>
            <p className="font-display text-base font-bold text-white">{card.title}</p>
            <p className="mt-1 text-sm text-mist">{card.id === "receive" ? receiveSubtitle : card.subtitle}</p>
          </button>
        ))}
      </div>

      {/* ── Quick links ── */}
      <div className="mt-6 flex flex-wrap gap-2">
        {QUICK_LINKS.map((link) => (
          <button
            key={link.id}
            type="button"
            onClick={() => onNavigate(link.id)}
            data-tour={link.id === "balance" ? "vault" : undefined}
            className="rounded-xl border border-ink-600 bg-ink-950/40 px-4 py-2 text-sm font-medium text-mist transition-colors hover:border-white/30 hover:text-white"
          >
            {link.label}
          </button>
        ))}
      </div>

      {/* ── Recent activity ── */}
      <section className="mt-7">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h3 className="text-xs font-semibold text-mist/70 uppercase tracking-widest">
            Recent Activity
          </h3>
          <button
            type="button"
            onClick={() => onNavigate("history")}
            className="text-xs text-mist/70 hover:text-white transition-colors"
          >
            View all
          </button>
        </div>
        {recentHistory.length === 0 ? (
          <div className="rounded-2xl border border-ink-700 bg-ink-900/20 p-8 text-center">
            <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full border border-ink-700 bg-ink-900/40 text-mist/80">
              <FiInbox size={18} aria-hidden />
            </div>
            <p className="font-display text-base font-bold text-white">No Transactions Yet</p>
            <p className="mt-1 text-sm text-mist">
              Your latest private sends, withdrawals, and traits will show up here.
            </p>
          </div>
        ) : (
          <ul className="space-y-2">
            {recentHistory.map((tx) => (
              <li
                key={tx.id}
                className="rounded-xl border border-ink-700 bg-ink-900/25 px-4 py-3"
              >
                <div className="flex flex-wrap items-center gap-2 text-xs text-mist/80">
                  <span>{formatDate(tx.timestamp)}</span>
                  <span className="rounded-md border border-ink-700 bg-ink-900/40 px-1.5 py-0.5 uppercase text-[10px]">
                    {tx.kind}
                  </span>
                  <span
                    className="ml-auto min-w-0 truncate font-mono text-mist"
                    title={tx.counterparty ?? ""}
                  >
                    {maskCounterparty(tx.counterparty ?? "-")}
                  </span>
                </div>
                <div className="mt-1 text-sm text-white">
                  {tx.kind === "trait" ? tx.amount : `${tx.amount} ${tx.tokenSymbol}`}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── Modals ── */}
      {showSwitchModal && (
        <SwitchNetworkModal
          title="Change network"
          description="Switch Stellar network. Your balance, history, and registration are per network and will refresh."
          showClose
          onClose={() => setShowSwitchModal(false)}
        />
      )}
    </div>
  );
}
