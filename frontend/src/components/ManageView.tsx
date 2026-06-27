/**
 * ManageView — Schema & Attestation Management
 *
 * Displays schemas the connected wallet has authority over and
 * attestations they have issued, with full management actions:
 *   - Deprecate schema
 *   - Add / remove delegates
 *   - Revoke attestations (with confirmation modal)
 *   - Search issued attestations by recipient stealth address hash
 *   - Paginated lists (10 per page)
 */

import { useEffect, useMemo, useState, useCallback, useId, useRef } from "react";
import { useWallet } from "../hooks/useWallet";
import { useSchemaStore } from "../store/schemaStore";
import type { SchemaV2 } from "../lib/schema";
import {
  bytesToHex,
  hexPubkeyToBase58,
  invokeAddDelegate,
  invokeDeprecateSchema,
  invokeRemoveDelegate,
  invokeRevokeAttestation,
  fetchIssuedAttestations,
  fetchAllSchemas,
} from "../lib/programs";
import type { Tab } from "./Layout";
import { ModalShell } from "./ModalShell";
import { AdminPanel } from "./AdminPanel";
import { ContractVersionPanelConnected } from "./ContractVersionPanel";
import { FeatureDisabledNotice } from "./FeatureDisabledNotice";

// =============================================================================
// Constants
// =============================================================================

const ITEMS_PER_PAGE = 10;

// =============================================================================
// Types
// =============================================================================

interface ManagedAttestation {
  address: string;
  uid: Uint8Array;
  uidHex: string;
  schemaPda: string;
  schemaId: Uint8Array;
  schemaIdHex: string;
  schemaName: string;
  stealthAddressHash: Uint8Array;
  createdAt: bigint;
  expirationSlot: bigint;
  revocationSlot: bigint;
  isRevoked: boolean;
  isExpired: boolean;
  isRevocable: boolean;
}

// =============================================================================
// Helpers
// =============================================================================

function shortAddr(addr: string): string {
  const b58 = hexPubkeyToBase58(addr);
  return `${b58.slice(0, 6)}…${b58.slice(-4)}`;
}

function shortHex(hex: string): string {
  const clean = hex.startsWith("0x") ? hex : `0x${hex}`;
  return `${clean.slice(0, 10)}…${clean.slice(-6)}`;
}

// =============================================================================
// Sub-components
// =============================================================================

function StatusBadge({ label, variant }: { label: string; variant: "green" | "red" | "yellow" | "gray" }) {
  const cls = {
    green: "border-neutral-400/30 bg-neutral-400/10 text-neutral-300",
    red: "border-neutral-500/30 bg-neutral-500/10 text-neutral-400",
    yellow: "border-neutral-500/30 bg-neutral-500/10 text-neutral-400",
    gray: "border-ink-600 bg-ink-800 text-mist",
  }[variant];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${cls}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${variant === "green" ? "bg-neutral-400" : variant === "red" ? "bg-neutral-400" : variant === "yellow" ? "bg-neutral-400" : "bg-mist/40"}`} />
      {label}
    </span>
  );
}

function PaginationControls({
  page,
  totalPages,
  onPrev,
  onNext,
}: {
  page: number;
  totalPages: number;
  onPrev: () => void;
  onNext: () => void;
}) {
  if (totalPages <= 1) return null;
  return (
    <div className="flex items-center justify-center gap-3 pt-2">
      <button
        type="button"
        onClick={onPrev}
        disabled={page === 1}
        className="rounded-lg border border-ink-700 bg-ink-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-ink-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        ← Prev
      </button>
      <span className="text-xs text-mist">
        Page {page} of {totalPages}
      </span>
      <button
        type="button"
        onClick={onNext}
        disabled={page === totalPages}
        className="rounded-lg border border-ink-700 bg-ink-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-ink-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        Next →
      </button>
    </div>
  );
}

// =============================================================================
// Schema card
// =============================================================================

interface SchemaCardProps {
  schema: SchemaV2;
  walletAddress: string;
  signTransaction: ((xdr: string) => Promise<string>) | null;
  onAction: (msg: string, isError?: boolean) => void;
  onDeprecated: (schema: SchemaV2, txHash: string) => void;
  onRefresh: () => void;
  readOnly?: boolean;
}

function SchemaCard({ schema, walletAddress, signTransaction, onAction, onDeprecated, onRefresh, readOnly = false }: SchemaCardProps) {
  const uid = useId();

  const [delegateInput, setDelegateInput] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDeprecateOpen, setConfirmDeprecateOpen] = useState(false);

  const schemaIdBytes = useMemo(
    () => Uint8Array.from(Buffer.from(schema.schemaId.replace(/^0x/, ""), "hex")),
    [schema.schemaId],
  );

  const handleDeprecate = useCallback(async () => {
    if (schema.deprecated) {
      onAction("This schema has already been deprecated.", true);
      return;
    }
    if (!signTransaction) {
      onAction("Wallet not connected", true);
      return;
    }

    setBusy("Deprecate schema");
    try {
      const txHash = await invokeDeprecateSchema({
        authority: walletAddress,
        schemaId: schemaIdBytes,
        signTransaction,
      });
      onDeprecated(schema, txHash);
      onAction(`Schema deprecated successfully. Tx: ${txHash.slice(0, 10)}...${txHash.slice(-6)}`);
    } catch (e) {
      onAction(e instanceof Error ? e.message : "Deprecate failed", true);
    } finally {
      setBusy(null);
    }
  }, [schema, walletAddress, schemaIdBytes, signTransaction, onAction, onDeprecated]);

  const handleAddDelegate = useCallback(async () => {
    const addr = delegateInput.trim();
    if (!addr) return;
    if (!signTransaction) {
      onAction("Wallet not connected", true);
      return;
    }
    setBusy("Add delegate");
    try {
      const txHash = await invokeAddDelegate({
        authority: walletAddress,
        schemaId: schemaIdBytes,
        delegate: addr,
        signTransaction,
      });
      setDelegateInput("");
      onAction(`Delegate ${addr.slice(0, 6)}… added. Tx: ${txHash.slice(0, 10)}…${txHash.slice(-6)}`);
      onRefresh();
    } catch (e) {
      onAction(e instanceof Error ? e.message : "Add delegate failed", true);
    } finally {
      setBusy(null);
    }
  }, [delegateInput, walletAddress, schemaIdBytes, signTransaction, onAction, onRefresh]);

  const handleRemoveDelegate = useCallback(async (delegateAddr: string) => {
    if (!signTransaction) {
      onAction("Wallet not connected", true);
      return;
    }
    setBusy("Remove delegate");
    try {
      const txHash = await invokeRemoveDelegate({
        authority: walletAddress,
        schemaId: schemaIdBytes,
        delegate: delegateAddr,
        signTransaction,
      });
      onAction(`Delegate ${delegateAddr.slice(0, 6)}… removed. Tx: ${txHash.slice(0, 10)}…${txHash.slice(-6)}`);
      onRefresh();
    } catch (e) {
      onAction(e instanceof Error ? e.message : "Remove delegate failed", true);
    } finally {
      setBusy(null);
    }
  }, [walletAddress, schemaIdBytes, signTransaction, onAction, onRefresh]);

  const isBusy = busy !== null;

  return (
    <>
      <div className={`rounded-xl border bg-ink-900 px-5 py-4 space-y-4 ${schema.deprecated ? "border-ink-800 opacity-70" : "border-ink-700"}`}>
        {/* Header row */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-semibold text-white text-sm truncate">{schema.name}</p>
            <p className="text-xs text-mist font-mono mt-0.5 truncate">{shortHex(schema.schemaId)}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {schema.deprecated
              ? <StatusBadge label="Deprecated" variant="gray" />
              : <StatusBadge label="Active" variant="green" />}
            {schema.revocable && <StatusBadge label="Revocable" variant="yellow" />}
          </div>
        </div>

        {/* Delegates */}
        <div className="space-y-2">
          <p className="text-xs text-ink-500 uppercase tracking-widest font-semibold">Delegates</p>
          {schema.delegates.length === 0 ? (
            <p className="text-xs text-mist italic">No delegates</p>
          ) : (
            <div className="space-y-1">
              {schema.delegates.map((d) => (
                <div key={d} className="flex items-center justify-between gap-2 rounded-lg bg-ink-800 px-3 py-1.5">
                  <span className="text-xs font-mono text-white">{shortAddr(d)}</span>
                  <button
                    type="button"
                    disabled={isBusy || schema.deprecated || readOnly}
                    onClick={() => void handleRemoveDelegate(d)}
                    className="text-xs text-neutral-400 hover:text-neutral-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    {busy === "Remove delegate" ? "…" : "Remove"}
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Add delegate */}
          {!schema.deprecated && !readOnly && (
            <div className="flex gap-2 pt-1">
              <input
                id={`${uid}-delegate`}
                type="text"
                placeholder="Delegate wallet address (base58)"
                value={delegateInput}
                onChange={(e) => setDelegateInput(e.target.value)}
                disabled={isBusy}
                className="flex-1 rounded-lg border border-ink-700 bg-ink-800 px-3 py-1.5 text-xs text-white placeholder-ink-500 focus:outline-none focus:border-white transition-colors disabled:opacity-50"
              />
              <button
                type="button"
                onClick={() => void handleAddDelegate()}
                disabled={isBusy || !delegateInput.trim()}
                className="rounded-lg bg-ink-700 hover:bg-ink-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {busy === "Add delegate" ? "…" : "Add"}
              </button>
            </div>
          )}
        </div>

        {/* Actions */}
        {!schema.deprecated && (
          <div className="pt-1 border-t border-ink-800">
            <button
              type="button"
              onClick={() => setConfirmDeprecateOpen(true)}
              disabled={isBusy}
              className="w-full rounded-lg border border-neutral-500/30 bg-neutral-500/5 hover:bg-neutral-500/10 px-4 py-2 text-xs font-medium text-neutral-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {busy === "Deprecate schema" ? "Deprecating…" : "Deprecate Schema"}
            </button>
            <p className="text-[11px] text-ink-500 mt-1.5 text-center">
              Deprecation is irreversible — no new attestations can be issued under this schema.
            </p>
          </div>
        )}
      </div>

      {/* Deprecate confirmation modal */}
      <ModalShell
        open={confirmDeprecateOpen}
        title="Deprecate Schema"
        description="This action is permanent and cannot be undone."
        onClose={() => setConfirmDeprecateOpen(false)}
        closeOnBackdrop={!isBusy}
        maxWidthClassName="max-w-sm"
      >
        <div className="space-y-4">
          <p className="text-sm text-mist">
            Deprecating <span className="text-white font-medium">{schema.name}</span> will permanently
            prevent any new attestations from being issued under this schema. Existing attestations
            will remain valid.
          </p>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => setConfirmDeprecateOpen(false)}
              disabled={isBusy}
              className="flex-1 rounded-lg border border-ink-700 bg-ink-800 px-4 py-2 text-sm font-medium text-white hover:bg-ink-700 disabled:opacity-40 transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirmDeprecateOpen(false);
                void handleDeprecate();
              }}
              disabled={isBusy}
              className="flex-1 rounded-lg border border-neutral-500/30 bg-neutral-500/10 hover:bg-neutral-500/20 px-4 py-2 text-sm font-medium text-neutral-400 disabled:opacity-40 transition-colors"
            >
              {busy === "Deprecate" ? "Deprecating…" : "Confirm Deprecate"}
            </button>
          </div>
        </div>
      </ModalShell>
    </>
  );
}

// =============================================================================
// Attestation card
// =============================================================================

interface AttestationCardProps {
  att: ManagedAttestation;
  revoker: string;
  signTransaction: ((xdr: string) => Promise<string>) | null;
  onRevoked: (attestationUid: string, txHash: string) => void;
  onAction: (msg: string, isError?: boolean) => void;
  readOnly?: boolean;
}

function AttestationCard({ att, revoker, signTransaction, onRevoked, onAction, readOnly = false }: AttestationCardProps) {
  const [revoking, setRevoking] = useState(false);
  const [confirmRevokeOpen, setConfirmRevokeOpen] = useState(false);

  const handleRevoke = async () => {
    if (att.isRevoked) {
      onAction("This attestation has already been revoked.", true);
      return;
    }
    if (!signTransaction) {
      onAction("Wallet not connected", true);
      return;
    }

    setRevoking(true);
    try {
      const txHash = await invokeRevokeAttestation({
        revoker,
        uid: att.uid,
        signTransaction,
      });
      onRevoked(att.uidHex, txHash);
      onAction(`Attestation revoked. Tx: ${txHash.slice(0, 10)}...${txHash.slice(-6)}`);
    } catch (e: unknown) {
      onAction(e instanceof Error ? e.message : "Revocation failed", true);
    } finally {
      setRevoking(false);
    }
  };

  const statusBadge = att.isRevoked
    ? <StatusBadge label="Revoked" variant="red" />
    : att.isExpired
    ? <StatusBadge label="Expired" variant="gray" />
    : <StatusBadge label="Active" variant="green" />;

  return (
    <>
      <div className={`rounded-xl border bg-ink-900 px-5 py-4 space-y-3 ${att.isRevoked || att.isExpired ? "border-ink-800 opacity-70" : "border-ink-700"}`}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-semibold text-white text-sm truncate">{att.schemaName}</p>
            <p className="text-xs text-mist font-mono mt-0.5">UID: {shortHex(att.uidHex)}</p>
          </div>
          {statusBadge}
        </div>

        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
          <div>
            <p className="text-ink-500">Recipient hash</p>
            <p className="font-mono text-white truncate">{shortHex(bytesToHex(att.stealthAddressHash))}</p>
          </div>
          <div>
            <p className="text-ink-500">Created slot</p>
            <p className="text-white">{att.createdAt.toLocaleString()}</p>
          </div>
          {att.expirationSlot > 0n && (
            <div>
              <p className="text-ink-500">Expires</p>
              <p className="text-white">Slot {att.expirationSlot.toLocaleString()}</p>
            </div>
          )}
        </div>

        {att.isRevocable && !att.isRevoked && !att.isExpired && !readOnly && (
          <button
            type="button"
            onClick={() => setConfirmRevokeOpen(true)}
            disabled={revoking}
            className="w-full rounded-lg border border-neutral-500/30 bg-neutral-500/5 hover:bg-neutral-500/10 px-4 py-2 text-xs font-medium text-neutral-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {revoking ? "Revoking…" : "Revoke Attestation"}
          </button>
        )}
      </div>

      {/* Revoke confirmation modal */}
      <ModalShell
        open={confirmRevokeOpen}
        title="Revoke Attestation"
        description="This action cannot be undone."
        onClose={() => setConfirmRevokeOpen(false)}
        closeOnBackdrop={!revoking}
        maxWidthClassName="max-w-sm"
      >
        <div className="space-y-4">
          <p className="text-sm text-mist">
            Are you sure you want to revoke this attestation issued under{" "}
            <span className="text-white font-medium">{att.schemaName}</span>? The recipient
            will no longer be able to generate valid proofs from this credential.
          </p>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => setConfirmRevokeOpen(false)}
              disabled={revoking}
              className="flex-1 rounded-lg border border-ink-700 bg-ink-800 px-4 py-2 text-sm font-medium text-white hover:bg-ink-700 disabled:opacity-40 transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirmRevokeOpen(false);
                void handleRevoke();
              }}
              disabled={revoking}
              className="flex-1 rounded-lg border border-neutral-500/30 bg-neutral-500/10 hover:bg-neutral-500/20 px-4 py-2 text-sm font-medium text-neutral-400 disabled:opacity-40 transition-colors"
            >
              {revoking ? "Revoking…" : "Confirm Revoke"}
            </button>
          </div>
        </div>
      </ModalShell>
    </>
  );
}

// =============================================================================
// Main view
// =============================================================================

interface ManageViewProps {
  onNavigate?: (tab: Tab) => void;
  readOnly?: boolean;
}

export function ManageView({ onNavigate, readOnly = false }: ManageViewProps = {}) {
  const { address: walletAddress, publicKey, connection, signTransaction } = useWallet();
  const schemaMap = useSchemaStore((s) => s.schemas);
  const addSchema = useSchemaStore((s) => s.addSchema);
  const markTraitInvalid = useSchemaStore((s) => s.markTraitInvalid);
  const setIsFetchingSchemas = useSchemaStore((s) => s.setIsFetchingSchemas);

  const [attestations, setAttestations] = useState<ManagedAttestation[]>([]);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState<{ msg: string; isError: boolean } | null>(null);
  const [section, setSection] = useState<"schemas" | "attestations" | "admin">("schemas");
  const [recipientSearch, setRecipientSearch] = useState("");
  const [attestationPage, setAttestationPage] = useState(1);
  const [schemaPage, setSchemaPage] = useState(1);
  const schemaSyncedRef = useRef(false);

  // Schemas this wallet has authority over — sorted newest first
  const mySchemas = useMemo(() => {
    if (!walletAddress) return [];
    return Object.values(schemaMap)
      .filter((s) => s.authority === walletAddress)
      .sort((a, b) => b.createdAt - a.createdAt);
  }, [schemaMap, walletAddress]);

  const showToast = useCallback((msg: string, isError = false) => {
    setToast({ msg, isError });
    setTimeout(() => setToast(null), 4000);
  }, []);

  const handleSchemaDeprecated = useCallback((schema: SchemaV2, _txHash: string) => {
    addSchema({ ...schema, deprecated: true });
  }, [addSchema]);

  const handleAttestationRevoked = useCallback((uidHex: string) => {
    const clean = uidHex.replace(/^0x/, "").toLowerCase();
    markTraitInvalid(clean);
    markTraitInvalid(`0x${clean}`);
    setAttestations((current) =>
      current.map((att) =>
        att.uidHex.replace(/^0x/, "").toLowerCase() === clean
          ? {
              ...att,
              isRevoked: true,
              revocationSlot: att.revocationSlot > 0n ? att.revocationSlot : 1n,
            }
          : att,
      ),
    );
  }, [markTraitInvalid]);

  // Filter attestations by recipient stealth address hash search
  const filteredAttestations = useMemo(() => {
    const q = recipientSearch.trim().toLowerCase().replace(/^0x/, "");
    if (!q) return attestations;
    return attestations.filter((att) => {
      const hashHex = bytesToHex(att.stealthAddressHash).toLowerCase();
      return hashHex.includes(q);
    });
  }, [attestations, recipientSearch]);

  // Paginated slices
  const pagedAttestations = useMemo(() => {
    const start = (attestationPage - 1) * ITEMS_PER_PAGE;
    return filteredAttestations.slice(start, start + ITEMS_PER_PAGE);
  }, [filteredAttestations, attestationPage]);

  const totalAttestationPages = Math.max(1, Math.ceil(filteredAttestations.length / ITEMS_PER_PAGE));

  const pagedSchemas = useMemo(() => {
    const start = (schemaPage - 1) * ITEMS_PER_PAGE;
    return mySchemas.slice(start, start + ITEMS_PER_PAGE);
  }, [mySchemas, schemaPage]);

  const totalSchemaPages = Math.max(1, Math.ceil(mySchemas.length / ITEMS_PER_PAGE));

  // Sync schemas from chain once per wallet session (#421)
  useEffect(() => {
    if (!walletAddress || schemaSyncedRef.current) return;
    schemaSyncedRef.current = true;
    setIsFetchingSchemas(true);
    fetchAllSchemas(walletAddress)
      .then((chainSchemas) => {
        for (const s of chainSchemas) {
          const schemaIdHex = "0x" + bytesToHex(s.schemaId);
          const existing = useSchemaStore.getState().schemas[schemaIdHex];
          if (!existing) {
            addSchema({
              address: "",
              schemaId: schemaIdHex,
              authority: s.authority,
              resolver: "",
              revocable: s.revocable,
              name: s.name,
              fieldDefinitions: s.fieldDefinitions,
              version: 1,
              delegates: s.delegates ?? [],
              createdAt: 0,
              schemaExpiryLedger: 0,
              schemaExpirySlot: 0,
              deprecated: s.deprecated,
            });
          } else if (s.deprecated && !existing.deprecated) {
            addSchema({ ...existing, deprecated: true });
          }
        }
      })
      .catch(console.error)
      .finally(() => setIsFetchingSchemas(false));
  }, [walletAddress, addSchema, setIsFetchingSchemas]);

  const load = useCallback(async () => {
    if (!publicKey || !walletAddress) return;
    setLoading(true);
    try {
      const [slot, chainAttestations] = await Promise.all([
        connection.getSlot(),
        fetchIssuedAttestations(walletAddress),
      ]);

      // Build schema lookup from current store for attestation labels
      const schemaRows = Object.values(schemaMap);
      const schemaHexMap = new Map<string, { name: string; revocable: boolean; schemaPda: string }>();
      for (const s of schemaRows) {
        schemaHexMap.set(
          s.schemaId.replace(/^0x/, "").toLowerCase(),
          { name: s.name, revocable: s.revocable, schemaPda: s.address },
        );
      }

      const slotBn = BigInt(slot);
      const mine: ManagedAttestation[] = chainAttestations
        .map((att) => {
          const sidHex = att.schemaIdHex.toLowerCase();
          const schemaInfo = schemaHexMap.get(sidHex);
          return {
            address: "",
            uid: att.uid,
            uidHex: att.uidHex,
            schemaPda: schemaInfo?.schemaPda ?? "",
            schemaId: att.schemaId,
            schemaIdHex: att.schemaIdHex,
            schemaName: schemaInfo?.name ?? "Unknown Schema",
            stealthAddressHash: att.stealthAddressHash,
            createdAt: att.createdAt,
            expirationSlot: att.expirationSlot,
            revocationSlot: att.revocationSlot,
            isRevoked: att.isRevoked,
            isExpired: att.expirationSlot > 0n && att.expirationSlot < slotBn,
            isRevocable: schemaInfo?.revocable ?? false,
          };
        })
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

      setAttestations(mine);
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Failed to load data", true);
    } finally {
      setLoading(false);
    }
  }, [publicKey, walletAddress, connection, schemaMap, showToast]);

  useEffect(() => {
    void load();
  }, [load]);

  // Reset to page 1 when search changes
  useEffect(() => {
    setAttestationPage(1);
  }, [recipientSearch]);

  if (!walletAddress || !publicKey) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-16 text-center">
        <p className="text-mist">Connect your wallet to manage schemas and attestations.</p>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 space-y-6">
      {readOnly && <FeatureDisabledNotice feature="schemaManagement" readOnly />}
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">Manage</h1>
          <p className="text-sm text-mist mt-1">
            Schemas you own and attestations you issued.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {onNavigate && !readOnly && (
            <button
              type="button"
              onClick={() => onNavigate("attest")}
              className="rounded-xl bg-sol-gradient text-white border border-transparent px-4 py-2 text-xs font-semibold hover:opacity-90 transition-colors"
            >
              Issue Attestation
            </button>
          )}
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="rounded-xl border border-ink-700 bg-ink-900 px-4 py-2 text-xs font-medium text-white hover:bg-ink-800 disabled:opacity-50 transition-colors"
          >
            {loading ? (
              <span className="flex items-center gap-1.5">
                <span className="h-3 w-3 animate-spin rounded-full border border-ink-600 border-t-white" />
                Loading…
              </span>
            ) : "Refresh"}
          </button>
        </div>
      </div>

      {/* Section tabs */}
      <div className="flex flex-wrap gap-2">
        {(["schemas", "attestations", ...(readOnly ? [] : ["admin" as const])] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setSection(s)}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors flex items-center gap-1.5 ${
              section === s
                ? "bg-sol-gradient text-white border border-transparent"
                : "bg-ink-900 border border-ink-700 text-mist hover:text-white"
            }`}
          >
            {s === "schemas" ? "My Schemas" : s === "attestations" ? "Attestations Issued" : "Admin"}
            {s !== "admin" && (
              <span className={`rounded-full px-1.5 py-0.5 text-[10px] ${section === s ? "bg-ink-700" : "bg-ink-700"}`}>
                {s === "schemas" ? mySchemas.length : attestations.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* ── Schemas section ── */}
      {section === "schemas" && (
        <>
          {loading && mySchemas.length === 0 ? (
            <div className="flex justify-center py-12">
              <span className="h-7 w-7 animate-spin rounded-full border-2 border-ink-600 border-t-white" />
            </div>
          ) : mySchemas.length === 0 ? (
            <div className="rounded-xl border border-ink-800 bg-ink-900/50 px-6 py-10 text-center space-y-3">
              <div className="w-10 h-10 rounded-full bg-ink-800 flex items-center justify-center mx-auto">
                <svg className="w-5 h-5 text-ink-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                </svg>
              </div>
              <p className="text-white font-medium">No schemas yet</p>
              <p className="text-sm text-mist max-w-xs mx-auto">
                You haven't created any schemas. Create one in Schema Studio.
              </p>
              {onNavigate && !readOnly && (
                <button
                  type="button"
                  onClick={() => onNavigate("schemas")}
                  className="mt-2 rounded-xl bg-sol-gradient text-white border border-transparent px-4 py-2 text-xs font-semibold hover:opacity-90 transition-colors"
                >
                  Create New Schema
                </button>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {pagedSchemas.map((schema) => (
                  <SchemaCard
                    key={schema.schemaId}
                    schema={schema}
                    walletAddress={walletAddress ?? ""}
                    signTransaction={signTransaction ?? null}
                    onAction={showToast}
                    onDeprecated={handleSchemaDeprecated}
                    onRefresh={() => void load()}
                    readOnly={readOnly}
                  />
                ))}
              </div>
              <PaginationControls
                page={schemaPage}
                totalPages={totalSchemaPages}
                onPrev={() => setSchemaPage((p) => Math.max(1, p - 1))}
                onNext={() => setSchemaPage((p) => Math.min(totalSchemaPages, p + 1))}
              />
            </div>
          )}
        </>
      )}

      {/* ── Attestations section ── */}
      {section === "attestations" && (
        <>
          {/* Recipient search */}
          {attestations.length > 0 && (
            <div className="relative">
              <svg
                className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-500 pointer-events-none"
                fill="none" viewBox="0 0 24 24" stroke="currentColor"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                type="text"
                placeholder="Search by recipient stealth address hash (0x…)"
                value={recipientSearch}
                onChange={(e) => setRecipientSearch(e.target.value)}
                className="w-full rounded-xl border border-ink-700 bg-ink-900 pl-9 pr-4 py-2.5 text-sm text-white placeholder-ink-500 focus:outline-none focus:border-white transition-colors"
              />
              {recipientSearch && (
                <button
                  type="button"
                  onClick={() => setRecipientSearch("")}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-500 hover:text-white transition-colors"
                >
                  ✕
                </button>
              )}
            </div>
          )}

          {loading && attestations.length === 0 ? (
            <div className="flex justify-center py-12">
              <span className="h-7 w-7 animate-spin rounded-full border-2 border-ink-600 border-t-white" />
            </div>
          ) : attestations.length === 0 ? (
            <div className="rounded-xl border border-ink-800 bg-ink-900/50 px-6 py-10 text-center space-y-3">
              <div className="w-10 h-10 rounded-full bg-ink-800 flex items-center justify-center mx-auto">
                <svg className="w-5 h-5 text-ink-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <p className="text-white font-medium">No attestations issued</p>
              <p className="text-sm text-mist max-w-xs mx-auto">
                You haven't issued any attestations yet.
              </p>
              {onNavigate && (
                <button
                  type="button"
                  onClick={() => onNavigate("attest")}
                  className="mt-2 rounded-xl bg-sol-gradient text-white border border-transparent px-4 py-2 text-xs font-semibold hover:opacity-90 transition-colors"
                >
                  Issue Attestation
                </button>
              )}
            </div>
          ) : filteredAttestations.length === 0 ? (
            <div className="rounded-xl border border-ink-800 bg-ink-900/50 px-6 py-8 text-center space-y-2">
              <p className="text-white font-medium">No matching attestations</p>
              <p className="text-sm text-mist">No attestations match that recipient hash.</p>
              <button
                type="button"
                onClick={() => setRecipientSearch("")}
                className="text-xs text-white hover:underline"
              >
                Clear search
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              {recipientSearch && (
                <p className="text-xs text-mist">
                  Showing {filteredAttestations.length} of {attestations.length} attestations
                </p>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {pagedAttestations.map((att) => (
                  <AttestationCard
                    key={att.uidHex}
                    att={att}
                    revoker={walletAddress}
                    signTransaction={signTransaction ?? null}
                    onRevoked={handleAttestationRevoked}
                    readOnly={readOnly}
                    onAction={showToast}
                  />
                ))}
              </div>
              <PaginationControls
                page={attestationPage}
                totalPages={totalAttestationPages}
                onPrev={() => setAttestationPage((p) => Math.max(1, p - 1))}
                onNext={() => setAttestationPage((p) => Math.min(totalAttestationPages, p + 1))}
              />
            </div>
          )}
        </>
      )}

      {/* ── Admin section ── */}
      {section === "admin" && (
        <div className="space-y-8">
          <AdminPanel />
          <div className="border-t border-ink-800 pt-6">
            <ContractVersionPanelConnected />
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className={`fixed bottom-24 md:bottom-6 left-4 right-4 md:left-auto md:right-6 z-50 max-w-sm md:ml-auto rounded-xl border px-4 py-3 text-sm shadow-2xl backdrop-blur-lg transition-all ${
          toast.isError
            ? "border-neutral-500/30 bg-neutral-950/80 text-neutral-300"
            : "border-neutral-400/30 bg-neutral-950/80 text-neutral-300"
        }`}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}
