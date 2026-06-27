/**
 * AdminPanel — admin transfer, pending admin acceptance, and multisig guidance.
 *
 * Implements the two-step admin hand-off pattern:
 *   1. Current admin calls transfer_admin(new_admin) → stores a pending admin.
 *   2. New admin calls accept_admin() → completes the transfer atomically.
 *
 * This prevents hijacking because the new admin must explicitly accept.
 * The panel also explains how to configure a Stellar multisig account for
 * all admin operations.
 *
 * Related: Issue #82 (admin transfer and multisig support).
 */

import { useState, useEffect, useCallback, useId } from "react";
import {
  Account,
  Contract,
  TransactionBuilder,
  BASE_FEE,
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { getSorobanServer, invokeContractMethod } from "../lib/stellar";
import { getNetworkPassphrase } from "../lib/chain";
import { isSimulationSuccess } from "../lib/sorobanErrors";
import { deployedAddresses } from "../contracts/deployedAddresses";
import { useWallet } from "../hooks/useWallet";
import { ModalShell } from "./ModalShell";
import { fetchRootHistory, type RootHistoryEntry } from "../lib/programs";

// =============================================================================
// Constants
// =============================================================================

/** Contracts that expose admin transfer methods. */
const ADMIN_CONTRACTS: { id: string; name: string }[] = [
  { id: deployedAddresses.reputationVerifier, name: "Reputation Verifier" },
  { id: deployedAddresses.groth16Verifier, name: "Groth16 Verifier" },
  { id: deployedAddresses.attestationEngineV2, name: "Attestation Engine V2" },
  { id: deployedAddresses.schemaRegistry, name: "Schema Registry" },
];

// =============================================================================
// Helpers
// =============================================================================

async function simulateRead(
  server: ReturnType<typeof getSorobanServer>,
  passphrase: string,
  sourcePublicKey: string,
  contractId: string,
  method: string,
): Promise<unknown> {
  if (!contractId) return null;
  try {
    const fakeAccount = new Account(sourcePublicKey, "0");
    const contract = new Contract(contractId);
    const tx = new TransactionBuilder(fakeAccount, {
      fee: BASE_FEE,
      networkPassphrase: passphrase,
    })
      .addOperation(contract.call(method))
      .setTimeout(30)
      .build();

    const sim = await server.simulateTransaction(tx);
    if (!isSimulationSuccess(sim) || !sim.result) return null;
    return scValToNative(sim.result.retval);
  } catch {
    return null;
  }
}

function shortAddr(addr: string) {
  return `${addr.slice(0, 8)}…${addr.slice(-6)}`;
}

// =============================================================================
// Types
// =============================================================================

interface AdminStatus {
  contractId: string;
  contractName: string;
  currentAdmin: string | null;
  pendingAdmin: string | null;
  /** true if the connected wallet is the current admin */
  isAdmin: boolean;
  /** true if the connected wallet is the pending admin (can accept) */
  isPendingAdmin: boolean;
}

interface AttestationMetrics {
  count: number | null;
  active: number | null;
  revoked: number | null;
  maxDataBytes: number | null;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function parseAttestationMetrics(countRaw: unknown, statsRaw: unknown): AttestationMetrics {
  const stats =
    statsRaw && typeof statsRaw === "object"
      ? (statsRaw as Record<string, unknown>)
      : {};
  return {
    count: toFiniteNumber(countRaw),
    active: toFiniteNumber(stats.active_count),
    revoked: toFiniteNumber(stats.revoked_count),
    maxDataBytes: toFiniteNumber(stats.max_attestation_data_len),
  };
}

type MetricRow = readonly [string, number | null];

// =============================================================================
// Per-contract admin card
// =============================================================================

interface AdminCardProps {
  status: AdminStatus;
  publicKey: string;
  signTransaction: ((xdr: string) => Promise<string>) | null;
  onRefresh: () => void;
}

function AdminCard({ status, publicKey, signTransaction, onRefresh }: AdminCardProps) {
  const uid = useId();
  const [transferInput, setTransferInput] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const isBusy = busy !== null;

  const invokeAdmin = useCallback(
    async (method: string, args: xdr.ScVal[]) => {
      if (!signTransaction) return;
      setError(null);
      setSuccess(null);
      setBusy(method);
      try {
        const txHash = await invokeContractMethod({
          sourcePublicKey: publicKey,
          contractId: status.contractId,
          method,
          args,
          signTransaction,
        });
        setSuccess(`Transaction submitted: ${txHash.slice(0, 12)}…`);
        onRefresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : `${method} failed`);
      } finally {
        setBusy(null);
        setTransferInput("");
      }
    },
    [publicKey, signTransaction, status.contractId, onRefresh],
  );

  const handleTransferAdmin = () => {
    if (!transferInput.trim()) return;
    setConfirmOpen(true);
  };

  const confirmTransfer = () => {
    setConfirmOpen(false);
    void invokeAdmin("transfer_admin", [
      nativeToScVal(transferInput.trim(), { type: "address" }),
    ]);
  };

  const handleAcceptAdmin = () => {
    void invokeAdmin("accept_admin", []);
  };

  const handleCancelTransfer = () => {
    void invokeAdmin("cancel_admin_transfer", []);
  };

  return (
    <>
      <div className="rounded-xl border border-ink-700 bg-ink-900 px-5 py-4 space-y-4">
        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-semibold text-white text-sm truncate">{status.contractName}</p>
            <p
              className="text-[11px] font-mono text-mist/60 mt-0.5 truncate"
              title={status.contractId}
            >
              {shortAddr(status.contractId)}
            </p>
          </div>
          {status.isAdmin && (
            <span className="inline-flex items-center gap-1 shrink-0 rounded-full border border-white/30 bg-ink-800 px-2 py-0.5 text-[11px] font-medium text-white">
              You are admin
            </span>
          )}
        </div>

        {/* Current admin */}
        <div className="space-y-1">
          <p className="text-xs text-ink-500 uppercase tracking-widest font-semibold">Current Admin</p>
          {status.currentAdmin ? (
            <p className="text-xs font-mono text-white break-all" title={status.currentAdmin}>
              {status.currentAdmin}
            </p>
          ) : (
            <p className="text-xs text-mist italic">Not available — contract may not expose get_admin()</p>
          )}
        </div>

        {/* Pending admin */}
        {status.pendingAdmin && (
          <div className="rounded-lg border border-neutral-500/30 bg-neutral-500/5 px-3 py-2 space-y-1">
            <p className="text-xs font-semibold text-neutral-400">Pending admin transfer</p>
            <p className="text-xs font-mono text-neutral-400/80 break-all" title={status.pendingAdmin}>
              {status.pendingAdmin}
            </p>
            <div className="flex gap-2 pt-1">
              {status.isPendingAdmin && (
                <button
                  type="button"
                  onClick={handleAcceptAdmin}
                  disabled={isBusy || !signTransaction}
                  className="rounded-lg bg-sol-gradient text-white border border-transparent px-3 py-1.5 text-xs font-semibold hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  {busy === "accept_admin" ? "Accepting…" : "Accept Transfer"}
                </button>
              )}
              {status.isAdmin && (
                <button
                  type="button"
                  onClick={handleCancelTransfer}
                  disabled={isBusy || !signTransaction}
                  className="rounded-lg border border-ink-700 bg-ink-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-ink-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  {busy === "cancel_admin_transfer" ? "Cancelling…" : "Cancel"}
                </button>
              )}
            </div>
          </div>
        )}

        {/* Transfer admin form — only shown to current admin */}
        {status.isAdmin && !status.pendingAdmin && (
          <div className="space-y-2 pt-1 border-t border-ink-800">
            <p className="text-xs text-ink-500 uppercase tracking-widest font-semibold pt-1">
              Initiate Admin Transfer
            </p>
            <div className="flex gap-2">
              <input
                id={`${uid}-new-admin`}
                type="text"
                placeholder="New admin address (G…)"
                value={transferInput}
                onChange={(e) => setTransferInput(e.target.value)}
                disabled={isBusy}
                className="flex-1 rounded-lg border border-ink-700 bg-ink-800 px-3 py-1.5 text-xs text-white placeholder-ink-500 focus:outline-none focus:border-white transition-colors disabled:opacity-50 font-mono"
              />
              <button
                type="button"
                onClick={handleTransferAdmin}
                disabled={isBusy || !transferInput.trim() || !signTransaction}
                className="rounded-lg bg-ink-700 hover:bg-ink-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {busy === "transfer_admin" ? "…" : "Propose"}
              </button>
            </div>
            <p className="text-[11px] text-mist/60">
              The new admin must call accept_admin() to complete the transfer.
              Until accepted, you remain admin and can cancel.
            </p>
          </div>
        )}

        {/* Feedback */}
        {error && (
          <p className="text-xs text-neutral-400 rounded-lg border border-neutral-500/20 bg-neutral-500/5 px-3 py-2">
            {error}
          </p>
        )}
        {success && (
          <p className="text-xs text-neutral-300 rounded-lg border border-neutral-400/20 bg-neutral-400/5 px-3 py-2">
            {success}
          </p>
        )}
      </div>

      {/* Confirm transfer modal */}
      <ModalShell
        open={confirmOpen}
        title="Confirm Admin Transfer"
        description="Propose a new admin for this contract."
        onClose={() => setConfirmOpen(false)}
        closeOnBackdrop={!isBusy}
        maxWidthClassName="max-w-sm"
      >
        <div className="space-y-4">
          <p className="text-sm text-mist">
            Proposing admin transfer for{" "}
            <span className="text-white font-medium">{status.contractName}</span> to:
          </p>
          <p className="text-xs font-mono bg-ink-800 rounded-lg px-3 py-2 text-white break-all">
            {transferInput}
          </p>
          <p className="text-xs text-mist/60">
            The transfer is only finalised when the new admin calls accept_admin().
            You can cancel at any time before acceptance.
          </p>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => setConfirmOpen(false)}
              className="flex-1 rounded-lg border border-ink-700 bg-ink-800 px-4 py-2 text-sm font-medium text-white hover:bg-ink-700 transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={confirmTransfer}
              className="flex-1 rounded-lg bg-sol-gradient text-white border border-transparent px-4 py-2 text-sm font-semibold hover:opacity-90 transition-colors"
            >
              Confirm Proposal
            </button>
          </div>
        </div>
      </ModalShell>
    </>
  );
}

// =============================================================================
// Attestation engine pause controls (#371)
// =============================================================================

type PauseScope = "attestation" | "merkle_updates" | "proof_verification";

interface PauseFlags {
  pausedAttestation: boolean;
  pausedMerkleUpdates: boolean;
  pausedProofVerification: boolean;
}

const PAUSE_LABELS: Record<PauseScope, string> = {
  attestation: "Attestation Issuance",
  merkle_updates: "Merkle Root Updates",
  proof_verification: "Proof Verification",
};

const PAUSE_METHODS: Record<PauseScope, { pause: string; unpause: string }> = {
  attestation: { pause: "pause_attestation", unpause: "unpause_attestation" },
  merkle_updates: { pause: "pause_merkle_updates", unpause: "unpause_merkle_updates" },
  proof_verification: { pause: "pause_proof_verification", unpause: "unpause_proof_verification" },
};

const PAUSE_FLAG_KEYS: Record<PauseScope, keyof PauseFlags> = {
  attestation: "pausedAttestation",
  merkle_updates: "pausedMerkleUpdates",
  proof_verification: "pausedProofVerification",
};

interface PauseControlsProps {
  publicKey: string;
  signTransaction: ((xdr: string) => Promise<string>) | null;
}

function PauseControls({ publicKey, signTransaction }: PauseControlsProps) {
  const [flags, setFlags] = useState<PauseFlags | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [confirmScope, setConfirmScope] = useState<PauseScope | null>(null);
  const [confirmAction, setConfirmAction] = useState<"pause" | "unpause">("pause");

  const loadFlags = useCallback(async () => {
    setIsLoading(true);
    try {
      const server = getSorobanServer();
      const passphrase = getNetworkPassphrase();
      const raw = await simulateRead(
        server,
        passphrase,
        publicKey,
        deployedAddresses.attestationEngineV2,
        "get_config",
      );
      if (raw && typeof raw === "object") {
        const cfg = raw as Record<string, unknown>;
        setFlags({
          pausedAttestation: cfg["paused_attestation"] === true,
          pausedMerkleUpdates: cfg["paused_merkle_updates"] === true,
          pausedProofVerification: cfg["paused_proof_verification"] === true,
        });
      }
    } catch {
      /* leave flags null so the section shows nothing */
    } finally {
      setIsLoading(false);
    }
  }, [publicKey]);

  useEffect(() => {
    void loadFlags();
  }, [loadFlags]);

  const invokePause = useCallback(
    async (scope: PauseScope, action: "pause" | "unpause") => {
      if (!signTransaction) return;
      const method = PAUSE_METHODS[scope][action];
      setError(null);
      setSuccess(null);
      setBusy(method);
      try {
        const txHash = await invokeContractMethod({
          sourcePublicKey: publicKey,
          contractId: deployedAddresses.attestationEngineV2,
          method,
          args: [nativeToScVal(publicKey, { type: "address" })],
          signTransaction,
        });
        setSuccess(`Transaction submitted: ${txHash.slice(0, 12)}…`);
        await loadFlags();
      } catch (e) {
        setError(e instanceof Error ? e.message : `${method} failed`);
      } finally {
        setBusy(null);
      }
    },
    [publicKey, signTransaction, loadFlags],
  );

  const handleToggle = (scope: PauseScope, currentlyPaused: boolean) => {
    setConfirmScope(scope);
    setConfirmAction(currentlyPaused ? "unpause" : "pause");
  };

  const confirmToggle = () => {
    if (!confirmScope) return;
    setConfirmScope(null);
    void invokePause(confirmScope, confirmAction);
  };

  return (
    <>
      <div className="rounded-xl border border-ink-700 bg-ink-900/40 px-4 py-3 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h4 className="text-sm font-semibold text-white">Pause Controls</h4>
            <p className="text-xs text-mist mt-0.5">
              Toggle operational pause flags on the Attestation Engine V2. Requires admin or governance auth.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void loadFlags()}
            disabled={isLoading}
            className="rounded-lg border border-ink-700 bg-ink-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-ink-800 disabled:opacity-50 transition-colors"
          >
            {isLoading ? (
              <span className="flex items-center gap-1.5">
                <span className="h-3 w-3 animate-spin rounded-full border border-ink-600 border-t-white" />
                Loading…
              </span>
            ) : "Refresh"}
          </button>
        </div>

        {flags === null && !isLoading && (
          <p className="text-xs text-mist italic">Pause state unavailable — contract may not be initialized.</p>
        )}

        {flags && (
          <div className="space-y-2">
            {(["attestation", "merkle_updates", "proof_verification"] as PauseScope[]).map((scope) => {
              const paused = flags[PAUSE_FLAG_KEYS[scope]];
              const method = PAUSE_METHODS[scope][paused ? "unpause" : "pause"];
              const isBusy = busy === PAUSE_METHODS[scope].pause || busy === PAUSE_METHODS[scope].unpause;
              return (
                <div
                  key={scope}
                  className="flex items-center justify-between gap-3 rounded-lg border border-ink-700 bg-ink-950/30 px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-white">{PAUSE_LABELS[scope]}</p>
                    <p className={`text-[11px] font-semibold mt-0.5 ${paused ? "text-amber-400" : "text-emerald-400"}`}>
                      {paused ? "PAUSED" : "ACTIVE"}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleToggle(scope, paused)}
                    disabled={isBusy || !signTransaction}
                    className={`shrink-0 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                      paused
                        ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20"
                        : "border-amber-500/40 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20"
                    }`}
                  >
                    {isBusy ? (paused ? "Unpausing…" : "Pausing…") : (paused ? "Unpause" : "Pause")}
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {error && (
          <p className="text-xs text-neutral-400 rounded-lg border border-neutral-500/20 bg-neutral-500/5 px-3 py-2">
            {error}
          </p>
        )}
        {success && (
          <p className="text-xs text-neutral-300 rounded-lg border border-neutral-400/20 bg-neutral-400/5 px-3 py-2">
            {success}
          </p>
        )}
      </div>

      {/* Confirmation modal */}
      <ModalShell
        open={confirmScope !== null}
        title={confirmAction === "pause" ? "Confirm Pause" : "Confirm Unpause"}
        description={
          confirmScope
            ? `${confirmAction === "pause" ? "Pause" : "Unpause"} ${PAUSE_LABELS[confirmScope]} on Attestation Engine V2.`
            : ""
        }
        onClose={() => setConfirmScope(null)}
        closeOnBackdrop
        maxWidthClassName="max-w-sm"
      >
        <div className="space-y-4">
          {confirmScope && (
            <>
              <p className="text-sm text-mist">
                {confirmAction === "pause"
                  ? `This will block all ${PAUSE_LABELS[confirmScope].toLowerCase()} operations. Users will receive a "Paused" error until you unpause.`
                  : `This will re-enable ${PAUSE_LABELS[confirmScope].toLowerCase()} operations.`}
              </p>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => setConfirmScope(null)}
                  className="flex-1 rounded-lg border border-ink-700 bg-ink-800 px-4 py-2 text-sm font-medium text-white hover:bg-ink-700 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={confirmToggle}
                  className={`flex-1 rounded-lg border px-4 py-2 text-sm font-semibold transition-colors ${
                    confirmAction === "pause"
                      ? "border-amber-500/60 bg-amber-500/20 text-amber-300 hover:bg-amber-500/30"
                      : "border-emerald-500/60 bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30"
                  }`}
                >
                  {confirmAction === "pause" ? "Confirm Pause" : "Confirm Unpause"}
                </button>
              </div>
            </>
          )}
        </div>
      </ModalShell>
    </>
  );
}

// =============================================================================
// Reputation root history audit view (#373)
// =============================================================================

const ROOT_HISTORY_PAGE_SIZE = 10;

function RootHistoryAudit({ publicKey }: { publicKey: string }) {
  const [entries, setEntries] = useState<RootHistoryEntry[]>([]);
  const [offset, setOffset] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);

  const load = useCallback(
    async (newOffset: number) => {
      setIsLoading(true);
      const page = await fetchRootHistory(
        publicKey,
        deployedAddresses.reputationVerifier,
        newOffset,
        ROOT_HISTORY_PAGE_SIZE,
      );
      setEntries(page);
      setOffset(newOffset);
      setHasMore(page.length === ROOT_HISTORY_PAGE_SIZE);
      setIsLoading(false);
    },
    [publicKey],
  );

  useEffect(() => {
    void load(0);
  }, [load]);

  return (
    <div className="rounded-xl border border-ink-700 bg-ink-900/40 px-4 py-3 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold text-white">Reputation Root History</h4>
          <p className="text-xs text-mist mt-0.5">Paginated Merkle root history from the Reputation Verifier.</p>
        </div>
        <button
          type="button"
          onClick={() => void load(offset)}
          disabled={isLoading}
          className="rounded-lg border border-ink-700 bg-ink-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-ink-800 disabled:opacity-50 transition-colors"
        >
          {isLoading ? (
            <span className="flex items-center gap-1.5">
              <span className="h-3 w-3 animate-spin rounded-full border border-ink-600 border-t-white" />
              Loading…
            </span>
          ) : "Refresh"}
        </button>
      </div>

      {entries.length === 0 && !isLoading ? (
        <p className="text-xs text-mist italic py-2">No root history found — no Merkle roots have been committed yet.</p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-ink-700 text-left">
                  <th className="pb-2 pr-4 text-[10px] uppercase tracking-widest text-mist/60 font-semibold w-12">Ledger</th>
                  <th className="pb-2 pr-4 text-[10px] uppercase tracking-widest text-mist/60 font-semibold">Root Hash</th>
                  <th className="pb-2 text-[10px] uppercase tracking-widest text-mist/60 font-semibold">Dataset Hash</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e, i) => (
                  <tr key={i} className="border-b border-ink-800/50 last:border-0">
                    <td className="py-1.5 pr-4 font-mono text-white">{e.ledger.toLocaleString()}</td>
                    <td className="py-1.5 pr-4 font-mono text-mist/80 truncate max-w-[180px]" title={e.root}>
                      {e.root.slice(0, 18)}…{e.root.slice(-6)}
                    </td>
                    <td className="py-1.5 font-mono text-mist/60 truncate max-w-[180px]" title={e.datasetHash}>
                      {e.datasetHash.slice(0, 18)}…{e.datasetHash.slice(-6)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex gap-2 justify-end pt-1">
            <button
              type="button"
              onClick={() => void load(Math.max(0, offset - ROOT_HISTORY_PAGE_SIZE))}
              disabled={offset === 0 || isLoading}
              className="rounded-lg border border-ink-700 bg-ink-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-ink-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Prev
            </button>
            <button
              type="button"
              onClick={() => void load(offset + ROOT_HISTORY_PAGE_SIZE)}
              disabled={!hasMore || isLoading}
              className="rounded-lg border border-ink-700 bg-ink-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-ink-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Next
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// =============================================================================
// Multisig guidance
// =============================================================================

function MultisigGuide() {
  return (
    <details className="group rounded-xl border border-ink-700 bg-ink-900/30">
      <summary className="flex cursor-pointer items-center justify-between px-4 py-3 text-xs font-medium text-mist hover:text-white transition-colors list-none">
        <span>Stellar Multisig Setup Guide</span>
        <svg
          className="h-4 w-4 transition-transform group-open:rotate-180"
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
          aria-hidden
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </summary>
      <div className="border-t border-ink-700 px-4 py-4 space-y-3 text-xs text-mist">
        <p className="font-semibold text-white">Why multisig?</p>
        <p>
          Single admin keys are unacceptable for mainnet. A Stellar multisig account
          requires multiple key holders to sign before admin operations are authorised,
          preventing a single-point-of-failure compromise.
        </p>

        <p className="font-semibold text-white mt-2">Setup steps</p>
        <ol className="list-decimal list-inside space-y-2">
          <li>
            Create a dedicated Stellar account to serve as the admin address
            (do not reuse a personal wallet).
          </li>
          <li>
            Add co-signer public keys via <code className="bg-ink-800 px-1 rounded">SET_OPTIONS</code> with
            the desired signer weights.
          </li>
          <li>
            Set <code className="bg-ink-800 px-1 rounded">med_threshold ≥ 2</code> (or your required quorum)
            so that medium-weight operations (contract calls) require multiple signatures.
          </li>
          <li>
            Set <code className="bg-ink-800 px-1 rounded">high_threshold = total_signers</code> for key
            rotation operations.
          </li>
          <li>
            Test the multisig account on testnet before transferring admin on mainnet.
          </li>
        </ol>

        <p className="font-semibold text-white mt-2">Signing admin transactions</p>
        <p>
          Build the transaction using Stellar Laboratory or the Stellar SDK,
          have each required signer sign the XDR envelope offline (hardware wallet
          recommended), then submit the fully-signed transaction.
        </p>

        <p className="font-semibold text-white mt-2">Deployment runbook</p>
        <ol className="list-decimal list-inside space-y-1">
          <li>Complete mainnet security audit signoff (docs/security/MAINNET_AUDIT_SIGNOFF.md).</li>
          <li>Deploy contracts — initial admin is the deployer key.</li>
          <li>Create the multisig admin account as above.</li>
          <li>Call transfer_admin(multisig_account) from the deployer key.</li>
          <li>Have the multisig account call accept_admin() (requires threshold signatures).</li>
          <li>Revoke or rotate the original deployer key.</li>
        </ol>
      </div>
    </details>
  );
}

// =============================================================================
// Main component
// =============================================================================

export function AdminPanel() {
  const { publicKey, signTransaction } = useWallet();
  const [statuses, setStatuses] = useState<AdminStatus[]>([]);
  const [attestationMetrics, setAttestationMetrics] = useState<AttestationMetrics | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!publicKey) return;
    setIsLoading(true);
    setError(null);
    try {
      const server = getSorobanServer();
      const passphrase = getNetworkPassphrase();

      const results = await Promise.allSettled(
        ADMIN_CONTRACTS.map(async (c) => {
          const [adminRaw, pendingRaw] = await Promise.all([
            simulateRead(server, passphrase, publicKey, c.id, "get_admin"),
            simulateRead(server, passphrase, publicKey, c.id, "get_pending_admin"),
          ]);

          const currentAdmin = typeof adminRaw === "string" ? adminRaw : null;
          const pendingAdmin = typeof pendingRaw === "string" ? pendingRaw : null;

          return {
            contractId: c.id,
            contractName: c.name,
            currentAdmin,
            pendingAdmin,
            isAdmin: currentAdmin === publicKey,
            isPendingAdmin: pendingAdmin === publicKey,
          } satisfies AdminStatus;
        }),
      );

      setStatuses(
        results.map((r, i) => {
          if (r.status === "fulfilled") return r.value;
          const c = ADMIN_CONTRACTS[i]!;
          return {
            contractId: c.id,
            contractName: c.name,
            currentAdmin: null,
            pendingAdmin: null,
            isAdmin: false,
            isPendingAdmin: false,
          };
        }),
      );

      const [countRaw, statsRaw] = await Promise.all([
        simulateRead(
          server,
          passphrase,
          publicKey,
          deployedAddresses.attestationEngineV2,
          "get_attestation_count",
        ),
        simulateRead(
          server,
          passphrase,
          publicKey,
          deployedAddresses.attestationEngineV2,
          "get_storage_stats",
        ),
      ]);
      setAttestationMetrics(parseAttestationMetrics(countRaw, statsRaw));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load admin status");
    } finally {
      setIsLoading(false);
    }
  }, [publicKey]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!publicKey) {
    return (
      <div className="rounded-xl border border-ink-700 bg-ink-900/30 px-4 py-6 text-center text-sm text-mist">
        Connect your wallet to view admin status.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-white">Admin Management</h3>
          <p className="text-xs text-mist mt-0.5">
            Transfer admin control and manage multisig configuration.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={isLoading}
          className="rounded-lg border border-ink-700 bg-ink-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-ink-800 disabled:opacity-50 transition-colors"
        >
          {isLoading ? (
            <span className="flex items-center gap-1.5">
              <span className="h-3 w-3 animate-spin rounded-full border border-ink-600 border-t-white" />
              Loading…
            </span>
          ) : "Refresh"}
        </button>
      </div>

      {error && (
        <p className="rounded-lg border border-neutral-500/30 bg-neutral-500/10 px-3 py-2 text-xs text-neutral-400">
          {error}
        </p>
      )}

      {attestationMetrics && (
        <div className="rounded-xl border border-ink-700 bg-ink-900/40 px-4 py-3">
          <div className="flex items-center justify-between gap-3 mb-3">
            <div>
              <h4 className="text-sm font-semibold text-white">Attestation Metrics</h4>
              <p className="text-xs text-mist mt-0.5">Read-only counters from Attestation Engine V2.</p>
            </div>
            <span className="text-[11px] font-mono text-mist/70">
              {shortAddr(deployedAddresses.attestationEngineV2)}
            </span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {([
              ["Issued", attestationMetrics.count],
              ["Active", attestationMetrics.active],
              ["Revoked", attestationMetrics.revoked],
              ["Max Data Bytes", attestationMetrics.maxDataBytes],
            ] satisfies MetricRow[]).map(([label, value]) => (
              <div key={label} className="rounded-lg border border-ink-700 bg-ink-950/40 px-3 py-2">
                <p className="text-[10px] uppercase tracking-widest text-mist/60">{label}</p>
                <p className="mt-1 text-sm font-semibold text-white">
                  {typeof value === "number" ? value.toLocaleString() : "N/A"}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      <PauseControls publicKey={publicKey} signTransaction={signTransaction} />

      {isLoading && statuses.length === 0 ? (
        <div className="flex justify-center py-8">
          <span className="h-7 w-7 animate-spin rounded-full border-2 border-ink-600 border-t-white" />
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {statuses.map((s) => (
            <AdminCard
              key={s.contractId}
              status={s}
              publicKey={publicKey}
              signTransaction={signTransaction}
              onRefresh={() => void load()}
            />
          ))}
        </div>
      )}

      <RootHistoryAudit publicKey={publicKey} />

      <MultisigGuide />
    </div>
  );
}
