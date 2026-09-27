/**
 * AdminPanel - admin transfer, pending admin acceptance, and multisig guidance.
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
import { getPoolConfig } from "../contracts/poolConfig";
import { getRelayerConfig } from "../contracts/relayerConfig";
import { invokeUpdateAspRoot, invokeUpdateStateRoot } from "../lib/programs";
import { isValidAdminAddress } from "../lib/adminInputValidation";

// =============================================================================
// Constants
// =============================================================================

type AdminContract = {
  id: string;
  name: string;
  readMethod: "get_admin" | "get_config" | null;
  configHasAdmin?: boolean;
  supportsTransfer: boolean;
  directTransfer?: boolean;
};

const poolConfig = getPoolConfig();
const relayerConfig = getRelayerConfig();
const ADMIN_CONTRACTS: AdminContract[] = [
  { id: deployedAddresses.reputationVerifier, name: "Reputation Verifier", readMethod: "get_config", configHasAdmin: true, supportsTransfer: true, directTransfer: true },
  { id: deployedAddresses.groth16Verifier, name: "Groth16 Verifier", readMethod: null, supportsTransfer: false },
  { id: deployedAddresses.attestationEngineV2, name: "Attestation Engine V2", readMethod: "get_config", configHasAdmin: true, supportsTransfer: true, directTransfer: true },
  { id: deployedAddresses.schemaRegistry, name: "Schema Registry", readMethod: null, supportsTransfer: false },
  ...(poolConfig ? [{ id: poolConfig.poolId, name: "Privacy Pool", readMethod: "get_config" as const, configHasAdmin: true, supportsTransfer: true, directTransfer: true }] : []),
  ...(relayerConfig ? [{ id: relayerConfig.registryId, name: "Relayer Registry", readMethod: "get_config" as const, configHasAdmin: true, supportsTransfer: true, directTransfer: true }] : []),
  { id: deployedAddresses.stealthRegistry, name: "Stealth Registry", readMethod: null, supportsTransfer: false },
  { id: deployedAddresses.stealthAnnouncer, name: "Stealth Announcer", readMethod: null, supportsTransfer: false },
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
  supportsTransfer: boolean;
  directTransfer: boolean;
}

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
    if (!isValidAdminAddress(transferInput)) {
      setError("Enter a valid Stellar account (G…) or contract (C…) address.");
      return;
    }
    setConfirmOpen(true);
  };

  const confirmTransfer = () => {
    setConfirmOpen(false);
    const args = status.directTransfer
      ? [nativeToScVal(publicKey, { type: "address" }), nativeToScVal(transferInput.trim(), { type: "address" })]
      : [nativeToScVal(transferInput.trim(), { type: "address" })];
    void invokeAdmin("transfer_admin", args);
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
            <span className="inline-flex items-center gap-1 shrink-0 rounded-full border border-white/30 bg-white/10 px-2 py-0.5 text-[11px] font-medium text-white">
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
            <p className="text-xs text-mist italic">{status.supportsTransfer ? "Admin address unavailable from this contract." : "This contract has no admin controls."}</p>
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
                  className="rounded-lg bg-white text-black border border-white px-3 py-1.5 text-xs font-semibold hover:bg-black hover:text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
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

        {/* Transfer admin form: only shown to current admin */}
        {status.supportsTransfer && status.isAdmin && !status.pendingAdmin && (
          <div className="space-y-2 pt-1 border-t border-ink-800">
            <p className="text-xs text-ink-500 uppercase tracking-widest font-semibold pt-1">
              Initiate Admin Transfer
            </p>
            <div className="flex gap-2">
              <input
                id={`${uid}-new-admin`}
                type="text"
                placeholder="New admin address (G… or C…)"
                value={transferInput}
                onChange={(e) => {
                  setTransferInput(e.target.value);
                  setError(null);
                }}
                disabled={isBusy}
                className="flex-1 rounded-lg border border-ink-700 bg-ink-800 px-3 py-1.5 text-xs text-white placeholder-ink-500 focus:outline-none focus:border-white transition-colors disabled:opacity-50 font-mono"
              />
              <button
                type="button"
                onClick={handleTransferAdmin}
                disabled={isBusy || !isValidAdminAddress(transferInput) || !signTransaction}
                className="rounded-lg bg-ink-700 hover:bg-ink-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {busy === "transfer_admin" ? "…" : status.directTransfer ? "Transfer Admin" : "Propose"}
              </button>
            </div>
            <p className="text-[11px] text-mist/60">
              {status.directTransfer
                ? "This contract transfers admin authority immediately when the transaction confirms."
                : "The new admin must call accept_admin() to complete the transfer. Until accepted, you remain admin and can cancel."}
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
        description={status.directTransfer ? "Transfer admin authority directly for this contract." : "Propose a new admin for this contract."}
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
            {status.directTransfer
              ? "This contract applies the transfer as soon as the transaction confirms."
              : "The transfer is only finalised when the new admin calls accept_admin(). You can cancel at any time before acceptance."}
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
              className="flex-1 rounded-lg bg-white text-black border border-white px-4 py-2 text-sm font-semibold hover:bg-black hover:text-white transition-colors"
            >
              {status.directTransfer ? "Transfer Admin" : "Confirm Proposal"}
            </button>
          </div>
        </div>
      </ModalShell>
    </>
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
          <li>Deploy contracts: initial admin is the deployer key.</li>
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
            c.readMethod
              ? simulateRead(server, passphrase, publicKey, c.id, c.readMethod)
              : Promise.resolve(null),
            c.supportsTransfer && !c.directTransfer
              ? simulateRead(server, passphrase, publicKey, c.id, "get_pending_admin")
              : Promise.resolve(null),
          ]);

          const adminValue = c.configHasAdmin && adminRaw && typeof adminRaw === "object"
            ? (adminRaw as { admin?: unknown }).admin
            : adminRaw;
          const currentAdmin = typeof adminValue === "string" ? adminValue : null;
          const pendingAdmin = typeof pendingRaw === "string" ? pendingRaw : null;

          return {
            contractId: c.id,
            contractName: c.name,
            currentAdmin,
            pendingAdmin,
            isAdmin: currentAdmin === publicKey,
            isPendingAdmin: pendingAdmin === publicKey,
            supportsTransfer: c.supportsTransfer,
            directTransfer: c.directTransfer ?? false,
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
            supportsTransfer: ADMIN_CONTRACTS[i]!.supportsTransfer,
            directTransfer: ADMIN_CONTRACTS[i]!.directTransfer ?? false,
          };
        }),
      );
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

      <MultisigGuide />
      <PoolOperations />
    </div>
  );
}

function parseRoot(value: string): Uint8Array | null {
  const hex = value.trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  return Uint8Array.from(hex.match(/.{2}/g)!, (byte) => Number.parseInt(byte, 16));
}

function PoolOperations() {
  const config = getPoolConfig();
  const { publicKey, signTransaction } = useWallet();
  const [isAdmin, setIsAdmin] = useState(false);
  const [depositsPaused, setDepositsPaused] = useState(false);
  const [withdrawalsPaused, setWithdrawalsPaused] = useState(false);
  const [withdrawalPausePending, setWithdrawalPausePending] = useState(false);
  const [stateRoot, setStateRoot] = useState("");
  const [aspRoot, setAspRoot] = useState("");
  const [datasetHash, setDatasetHash] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!config || !publicKey) return;
    const server = getSorobanServer();
    const passphrase = getNetworkPassphrase();
    const [rawConfig, deposits, withdrawals, pauseRequest] = await Promise.all([
      simulateRead(server, passphrase, publicKey, config.poolId, "get_config"),
      simulateRead(server, passphrase, publicKey, config.poolId, "is_deposits_paused"),
      simulateRead(server, passphrase, publicKey, config.poolId, "is_withdrawals_paused"),
      simulateRead(server, passphrase, publicKey, config.poolId, "get_withdrawal_pause_request"),
    ]);
    const admin = rawConfig && typeof rawConfig === "object"
      ? (rawConfig as { admin?: unknown }).admin
      : null;
    setIsAdmin(admin === publicKey);
    setDepositsPaused(deposits === true);
    setWithdrawalsPaused(withdrawals === true);
    setWithdrawalPausePending(Array.isArray(pauseRequest) && Number(pauseRequest[0]) > 0 && withdrawals !== true);
  }, [config, publicKey]);

  useEffect(() => { void refresh(); }, [refresh]);

  const invokePool = async (method: string) => {
    if (!config || !publicKey || !signTransaction) return;
    setBusy(method); setError(null); setMessage(null);
    try {
      const hash = await invokeContractMethod({
        sourcePublicKey: publicKey,
        contractId: config.poolId,
        method,
        args: [nativeToScVal(publicKey, { type: "address" })],
        signTransaction,
      });
      setMessage(`${method} confirmed: ${hash.slice(0, 12)}…`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : `${method} failed`);
    } finally { setBusy(null); }
  };

  const publishRoot = async (kind: "state" | "asp") => {
    if (!config || !publicKey || !signTransaction) return;
    const root = parseRoot(kind === "state" ? stateRoot : aspRoot);
    const dataset = parseRoot(datasetHash);
    if (!root || !dataset) {
      setError("Root and dataset hash must each be 32-byte hexadecimal values.");
      return;
    }
    setBusy(`${kind}-root`); setError(null); setMessage(null);
    try {
      const submit = kind === "state" ? invokeUpdateStateRoot : invokeUpdateAspRoot;
      const hash = await submit({ admin: publicKey, root, datasetHash: dataset, signTransaction });
      setMessage(`${kind === "state" ? "State" : "ASP"} root published: ${hash.slice(0, 12)}…`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Root publication failed");
    } finally { setBusy(null); }
  };

  if (!config) return null;
  return (
    <section className="rounded-xl border border-ink-700 bg-ink-900/40 p-5 space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-white">Privacy Pool Controls</h3>
        <p className="text-xs text-mist mt-1">Publish pool roots and manage pause controls.</p>
      </div>
      {!publicKey ? <p className="text-xs text-mist">Connect an admin wallet to view controls.</p> : !isAdmin ? (
        <p className="text-xs text-mist">Controls are available to the configured pool admin.</p>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={!signTransaction || busy !== null} onClick={() => void invokePool(depositsPaused ? "unpause_deposits" : "pause_deposits")} className="rounded-lg border border-ink-700 bg-ink-800 px-3 py-2 text-xs text-white disabled:opacity-50">
              {busy?.includes("deposits") ? "Submitting…" : depositsPaused ? "Resume deposits" : "Pause deposits"}
            </button>
            <button type="button" disabled={!signTransaction || busy !== null} onClick={() => void invokePool(withdrawalsPaused || withdrawalPausePending ? "unpause_withdrawals" : "request_pause_withdrawals")} className="rounded-lg border border-ink-700 bg-ink-800 px-3 py-2 text-xs text-white disabled:opacity-50">
              {busy?.includes("withdrawals") ? "Submitting…" : withdrawalsPaused ? "Resume withdrawals" : withdrawalPausePending ? "Cancel withdrawal pause request" : "Request withdrawal pause"}
            </button>
          </div>
          <p className="text-[11px] text-mist">Deposits: {depositsPaused ? "paused" : "active"} · Withdrawals: {withdrawalsPaused ? "paused" : withdrawalPausePending ? "pause pending" : "active"}. Withdrawal pauses use the contract timelock.</p>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="text-xs text-mist">State root (32-byte hex)<input value={stateRoot} onChange={(e) => setStateRoot(e.target.value)} className="mt-1 w-full rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 font-mono text-white" /></label>
            <label className="text-xs text-mist">ASP root (32-byte hex)<input value={aspRoot} onChange={(e) => setAspRoot(e.target.value)} className="mt-1 w-full rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 font-mono text-white" /></label>
          </div>
          <label className="block text-xs text-mist">Dataset hash (32-byte hex)<input value={datasetHash} onChange={(e) => setDatasetHash(e.target.value)} className="mt-1 w-full rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 font-mono text-white" /></label>
          <div className="flex gap-2">
            <button type="button" disabled={!parseRoot(stateRoot) || !parseRoot(datasetHash) || busy !== null || !signTransaction} onClick={() => void publishRoot("state")} className="rounded-lg bg-white px-3 py-2 text-xs font-semibold text-black disabled:opacity-50">Publish state root</button>
            <button type="button" disabled={!parseRoot(aspRoot) || !parseRoot(datasetHash) || busy !== null || !signTransaction} onClick={() => void publishRoot("asp")} className="rounded-lg bg-white px-3 py-2 text-xs font-semibold text-black disabled:opacity-50">Publish ASP root</button>
          </div>
        </>
      )}
      {error && <p role="alert" className="text-xs text-neutral-300">{error}</p>}
      {message && <p className="text-xs text-mist">{message}</p>}
    </section>
  );
}
