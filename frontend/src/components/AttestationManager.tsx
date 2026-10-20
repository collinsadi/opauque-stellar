/**
 * Attestation Manager - V2 Issue Attestation UI
 *
 * Allows schema authorities and delegates to issue attestations under
 * a registered schema. The issuer selects a schema, enters the recipient's
 * stealth address hash, fills in the schema-defined fields, and submits.
 */

import { useEffect, useMemo, useState, useId } from "react";
import type { Tab } from "./Layout";
import { keccak_256 } from "@noble/hashes/sha3";
import { useWallet } from "../hooks/useWallet";
import { useSchemaStore } from "../store/schemaStore";
import { useTxHistoryStore } from "../store/txHistoryStore";
import { usePendingAttestationStore } from "../store/pendingAttestationStore";
import { getCluster } from "../lib/chain";
import { getExplorerTxUrl } from "../lib/explorer";
import { parseFieldDefs } from "../lib/schema";
import { encodeAttestationData } from "../lib/attestationV2";
import { computeStealthAddressAndViewTag } from "../lib/stealth";
import { hexToBytes, invokeAttest } from "../lib/programs";
import { getFeatureFlags } from "../lib/featureFlags";
import { FeatureDisabledNotice } from "./FeatureDisabledNotice";
import { fetchSchemasFromChain } from "../lib/chainSync";
import { toHex, type PendingAttestation } from "../lib/pendingAttestations";
import { advancePendingAttestation } from "../hooks/usePendingAttestationRecovery";
import {
  isMetaAddressRecipient,
  recipientDiscoveryMessage,
  recipientReference,
} from "../lib/attestationRecipients";

// =============================================================================
// Component
// =============================================================================

interface AttestationManagerProps {
  onNavigate?: (tab: Tab) => void;
}

export function AttestationManager({
  onNavigate,
}: AttestationManagerProps = {}) {
  const schemaManagementEnabled = getFeatureFlags().schemaManagement;
  const {
    address: walletAddress,
    publicKey,
    signTransaction,
    connection,
  } = useWallet();
  const pushTx = useTxHistoryStore((s) => s.push);
  const cluster = getCluster();
  const isFetchingSchemas = useSchemaStore((s) => s.isFetchingSchemas);
  const schemaMap = useSchemaStore((s) => s.schemas);
  const setSchemas = useSchemaStore((s) => s.setSchemas);
  const setIsFetchingSchemas = useSchemaStore((s) => s.setIsFetchingSchemas);
  const [schemaSyncError, setSchemaSyncError] = useState<string | null>(null);
  const schemas = useMemo(() => {
    if (!walletAddress) return [];
    return Object.values(schemaMap).filter(
      (s) =>
        !s.deprecated &&
        (s.authority === walletAddress || s.delegates.includes(walletAddress)),
    );
  }, [schemaMap, walletAddress]);

  const [selectedSchemaId, setSelectedSchemaId] = useState<string>("");
  const [recipientInput, setRecipientInput] = useState("");
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [expiryDateTime, setExpiryDateTime] = useState("");
  const [hasExpiry, setHasExpiry] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [txSig, setTxSig] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resolvedStealthAddress, setResolvedStealthAddress] = useState<
    string | null
  >(null);
  // This submission carries a recipient announcement; whether it went out is derived from the pending store.
  const [expectsAnnouncement, setExpectsAnnouncement] = useState(false);
  const [isRetryingAnnouncement, setIsRetryingAnnouncement] = useState(false);
  const pendingAttestations = usePendingAttestationStore((s) => s.pending);
  const submissionPending: PendingAttestation | null = txSig
    ? pendingAttestations.find((p) => p.txHash === txSig && p.cluster === cluster) ?? null
    : null;
  // Once the record leaves the pending store, the attestation is fully recorded and announced.
  const hasAnnouncement = expectsAnnouncement && txSig !== null && submissionPending === null;

  const uid = useId();

  // #1134: Sync schemas from chain when the issuer view opens
  useEffect(() => {
    if (!publicKey) return;
    let cancelled = false;
    setIsFetchingSchemas(true);
    setSchemaSyncError(null);
    fetchSchemasFromChain(cluster, publicKey)
      .then((chainSchemas) => {
        if (!cancelled && chainSchemas.length > 0) {
          setSchemas(chainSchemas);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setSchemaSyncError(err instanceof Error ? err.message : "Failed to load schemas from chain");
        }
      })
      .finally(() => {
        if (!cancelled) setIsFetchingSchemas(false);
      });
    return () => { cancelled = true; };
  }, [publicKey, cluster, setSchemas, setIsFetchingSchemas]);

  useEffect(() => {
    if (!selectedSchemaId) return;
    if (!schemas.some((s) => s.schemaId === selectedSchemaId)) {
      setSelectedSchemaId("");
      setFieldValues({});
    }
  }, [schemas, selectedSchemaId]);

  const selectedSchema = schemas.find((s) => s.schemaId === selectedSchemaId);
  const parsedFields = selectedSchema
    ? parseFieldDefs(selectedSchema.fieldDefinitions)
    : [];

  const canSubmit =
    walletAddress != null &&
    publicKey != null &&
    selectedSchemaId !== "" &&
    recipientInput.trim().length > 0 &&
    !isSubmitting;

  const handleFieldChange = (name: string, value: string) => {
    setFieldValues((prev) => ({ ...prev, [name]: value }));
  };

  const retrySubmissionPending = async () => {
    if (!submissionPending || !signTransaction) return;
    setIsRetryingAnnouncement(true);
    try {
      await advancePendingAttestation(submissionPending, signTransaction);
    } finally {
      setIsRetryingAnnouncement(false);
    }
  };

  const resolveStealthAddressHash = (
    input: string,
  ): {
    stealthHashBytes: Uint8Array;
    stealthAddressHex?: string;
    ephemeralPubKey?: Uint8Array;
    viewTag?: number;
  } => {
    const trimmed = input.trim();
    const normalized = trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
    const bytes = hexToBytes(normalized);

    // Meta-address (66 bytes): derive stealth address and keep ephemeral key for announcement.
    if (bytes.length === 66) {
      const { stealthAddress, ephemeralPubKey, viewTag } =
        computeStealthAddressAndViewTag(normalized as `0x${string}`);
      const stealthAddressBytes = hexToBytes(stealthAddress);
      const stealthHashBytes = keccak_256(stealthAddressBytes);
      return {
        stealthHashBytes,
        stealthAddressHex: stealthAddress,
        ephemeralPubKey,
        viewTag,
      };
    }

    // Stealth address (20 bytes): hash directly. No ephemeral key available.
    if (bytes.length === 20) {
      const stealthHashBytes = keccak_256(bytes);
      return { stealthHashBytes, stealthAddressHex: normalized };
    }

    // Backward compatibility: allow already-hashed 32-byte input.
    if (bytes.length === 32) {
      return { stealthHashBytes: bytes };
    }

    throw new Error(
      "Recipient must be a 66-byte meta-address, 20-byte stealth address, or 32-byte precomputed hash.",
    );
  };

  const handleSubmit = async () => {
    if (!canSubmit || !selectedSchema || !publicKey || !signTransaction) return;
    setIsSubmitting(true);
    setError(null);

    try {
      const issuer = publicKey;

      const schemaIdBytes = hexToBytes(selectedSchema.schemaId);

      const { stealthHashBytes, stealthAddressHex, ephemeralPubKey, viewTag } =
        resolveStealthAddressHash(recipientInput);
      setResolvedStealthAddress(stealthAddressHex ?? null);

      const attestationData = encodeAttestationData(
        fieldValues,
        parsedFields.map((f) => ({ name: f.name, type: f.type })),
      );

      let expirySlotNum = 0;
      if (hasExpiry) {
        if (!expiryDateTime) {
          throw new Error("Please select an expiration date and time.");
        }
        const targetMs = Date.parse(expiryDateTime);
        if (!Number.isFinite(targetMs)) {
          throw new Error("Invalid expiration date/time.");
        }
        const nowMs = Date.now();
        if (targetMs <= nowMs) {
          throw new Error("Expiration date/time must be in the future.");
        }
        const currentSlot = await connection.getSlot();
        const slotsUntilExpiry = Math.ceil((targetMs - nowMs) / 400); // ~400ms per slot
        expirySlotNum = currentSlot + Math.max(1, slotsUntilExpiry);
      }
      const refUid = new Uint8Array(32);

      const signature = await invokeAttest({
        issuer,
        schemaId: schemaIdBytes,
        stealthAddressHash: stealthHashBytes,
        data: attestationData,
        expirationLedger: expirySlotNum,
        refUid,
        signTransaction,
      });

      let createdAtSlot = 0;
      try {
        createdAtSlot = await connection.getSlot();
      } catch {
        /* best effort, leave 0 */
      }

      // Persist the issuance before any UID lookup or announcement, so a slow RPC or a reload
      // cannot lose it. Recovery records it on the Manage page and announces it once the UID resolves.
      // The announcement is the full V2 payload (see lib/pendingAttestations.ts), or the scanner drops it.
      const pending: PendingAttestation = {
        cluster,
        txHash: signature,
        issuer,
        schemaIdHex: selectedSchema.schemaId,
        schemaName: selectedSchema.name,
        stealthAddressHashHex: toHex(stealthHashBytes),
        isRevocable: selectedSchema.revocable,
        createdAtSlot,
        expirationSlot: expirySlotNum,
        uidHex: null,
        // A meta-address gives us the ephemeral key, so the recipient can be notified.
        announcement:
          ephemeralPubKey && stealthAddressHex && viewTag !== undefined
            ? { stealthAddressHex, ephemeralPubKeyHex: toHex(ephemeralPubKey), viewTag }
            : null,
        announceError: null,
        createdAt: Date.now(),
      };
      usePendingAttestationStore.getState().upsert(pending);
      setExpectsAnnouncement(pending.announcement !== null);
      await advancePendingAttestation(pending, signTransaction);

      setTxSig(signature);

      // Log attestation issuance to transaction history
      if (cluster) {
        pushTx({
          cluster,
          kind: "trait",
          counterparty: recipientReference(recipientInput),
          amountStroops: "0",
          tokenSymbol: "XLM",
          tokenAddress: null,
          amount: "0",
          txHash: signature,
        });
      }
    } catch (e) {
      const msg =
        e instanceof Error ? e.message : "Failed to issue attestation";
      setError(msg);
      console.error("[AttestationManager] Issue attestation failed:", e);
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!schemaManagementEnabled) {
    return (
      <div className="max-w-lg mx-auto py-8">
        <FeatureDisabledNotice feature="schemaManagement" />
      </div>
    );
  }

  if (txSig) {
    return (
      <div className="flex flex-col items-center justify-center gap-6 py-12 px-4 text-center">
        <div className="w-12 h-12 rounded-full bg-neutral-400/10 flex items-center justify-center">
          <svg
            className="w-6 h-6 text-neutral-300"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M5 13l4 4L19 7"
            />
          </svg>
        </div>
        <div>
          <p className="text-white font-semibold text-lg">Attestation issued</p>
          <p className="text-mist text-sm mt-1">
            {recipientDiscoveryMessage(hasAnnouncement && isMetaAddressRecipient(recipientInput))}
          </p>
          {submissionPending && (
            <div className="mt-3 space-y-2" role="alert">
              <p className="text-xs text-neutral-300">
                {submissionPending.announceError
                  ? `Attestation issued, but announcement failed: ${submissionPending.announceError}`
                  : "Attestation issued, but its on-chain record is not available yet. It will be recorded and announced automatically. You can also retry now."}
              </p>
              <button type="button" onClick={() => void retrySubmissionPending()} disabled={isRetryingAnnouncement} className="rounded-lg border border-ink-700 bg-ink-900 px-3 py-1.5 text-xs text-white disabled:opacity-50">
                {isRetryingAnnouncement ? "Retrying…" : "Retry"}
              </button>
            </div>
          )}
          <a
            href={getExplorerTxUrl(txSig)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-white hover:underline mt-2 inline-block font-mono"
          >
            {txSig.slice(0, 20)}… ↗
          </a>
        </div>
        <button
          type="button"
          onClick={() => {
            setTxSig(null);
            setRecipientInput("");
            setResolvedStealthAddress(null);
            setExpectsAnnouncement(false);
            setFieldValues({});
            setHasExpiry(false);
            setExpiryDateTime("");
          }}
          className="rounded-xl bg-ink-800 px-6 py-2.5 text-sm font-medium text-white hover:bg-ink-700 transition-colors"
        >
          Issue another attestation
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-8 space-y-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">Issue Attestation</h1>
          <p className="text-mist text-sm mt-1">
            Issue a schema-bound credential to a stealth address.
          </p>
        </div>
        {onNavigate && (
          <button
            type="button"
            onClick={() => onNavigate("schemas")}
            className="shrink-0 rounded-xl border border-ink-700 bg-ink-900 px-4 py-2 text-xs font-medium text-white hover:bg-ink-800 transition-colors"
          >
            Create New Schema
          </button>
        )}
      </div>

      {/* Schema selector */}
      <section className="space-y-2">
        <label
          htmlFor={`${uid}-schema`}
          className="block text-sm font-medium text-white"
        >
          Schema <span className="text-neutral-400">*</span>
        </label>
        {isFetchingSchemas ? (
          <div className="rounded-xl border border-ink-700 bg-ink-900 px-4 py-4 text-sm text-mist">
            Loading schemas from chain...
          </div>
        ) : schemas.length === 0 ? (
          <div className="rounded-xl border border-ink-700 bg-ink-900 px-4 py-4 text-sm text-mist flex items-center justify-between gap-4">
            <span>You have no schemas you can attest under.</span>
            {onNavigate ? (
              <button
                type="button"
                onClick={() => onNavigate("schemas")}
                className="shrink-0 rounded-lg bg-white text-black border border-white px-3 py-1.5 text-xs font-semibold hover:bg-black hover:text-white transition-colors"
              >
                Create New Schema
              </button>
            ) : (
              <strong className="text-white shrink-0">Schema Studio</strong>
            )}
          </div>
        ) : (
          <select
            id={`${uid}-schema`}
            value={selectedSchemaId}
            onChange={(e) => {
              setSelectedSchemaId(e.target.value);
              setFieldValues({});
            }}
            className="w-full rounded-xl border border-ink-700 bg-ink-900 px-4 py-3 text-white focus:outline-none focus:border-white text-sm"
          >
            <option value="">Select a schema…</option>
            {schemas.map((s) => (
              <option key={s.schemaId} value={s.schemaId}>
                {s.name}{" "}
                {s.authority === walletAddress ? "(authority)" : "(delegate)"}
              </option>
            ))}
          </select>
        )}
        {selectedSchema && (
          <p className="text-xs text-mist font-mono bg-ink-900/50 rounded-lg px-3 py-2 border border-ink-800">
            Fields:{" "}
            <span className="text-white">
              {selectedSchema.fieldDefinitions}
            </span>
          </p>
        )}
      </section>

      {/* Recipient meta-address / stealth address */}
      <section className="space-y-2">
        <label
          htmlFor={`${uid}-hash`}
          className="block text-sm font-medium text-white"
        >
          Recipient (Meta-Address or Stealth Address){" "}
          <span className="text-neutral-400">*</span>
        </label>
        <input
          id={`${uid}-hash`}
          type="text"
          placeholder="0x… (66-byte meta-address or 20-byte stealth address)"
          value={recipientInput}
          onChange={(e) => setRecipientInput(e.target.value)}
          className="w-full rounded-xl border border-ink-700 bg-ink-900 px-4 py-3 text-white placeholder-ink-500 focus:outline-none focus:border-white text-sm font-mono"
        />
        <p className="text-xs text-mist">
          If you provide a meta-address, a stealth address is derived first. The
          attestation stores only keccak256(stealthAddress) on-chain.
        </p>
        {resolvedStealthAddress && (
          <p className="text-xs text-mist font-mono bg-ink-900/50 rounded-lg px-3 py-2 border border-ink-800">
            Resolved stealth address:{" "}
            <span className="text-white">{resolvedStealthAddress}</span>
          </p>
        )}
      </section>

      {/* Dynamic field inputs */}
      {parsedFields.length > 0 && (
        <section className="space-y-4">
          <h2 className="text-sm font-medium text-white">Attestation Data</h2>
          <div className="space-y-3">
            {parsedFields.map((field) => (
              <div key={field.id} className="space-y-1">
                <label className="block text-xs font-medium text-mist">
                  {field.name}{" "}
                  <span className="text-ink-500">({field.type})</span>
                </label>
                {field.type === "bool" ? (
                  <select
                    value={fieldValues[field.name] ?? "true"}
                    onChange={(e) =>
                      handleFieldChange(field.name, e.target.value)
                    }
                    className="w-full rounded-xl border border-ink-700 bg-ink-900 px-4 py-2.5 text-white focus:outline-none focus:border-white text-sm"
                  >
                    <option value="true">true</option>
                    <option value="false">false</option>
                  </select>
                ) : (
                  <input
                    type={field.type.startsWith("u") ? "number" : "text"}
                    min={0}
                    placeholder={`${field.name} (${field.type})`}
                    value={fieldValues[field.name] ?? ""}
                    onChange={(e) =>
                      handleFieldChange(field.name, e.target.value)
                    }
                    className="w-full rounded-xl border border-ink-700 bg-ink-900 px-4 py-2.5 text-white placeholder-ink-500 focus:outline-none focus:border-white text-sm"
                  />
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Expiration */}
      <section className="space-y-3">
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={hasExpiry}
            onChange={(e) => setHasExpiry(e.target.checked)}
            className="h-4 w-4 accent-white"
          />
          <span className="text-sm text-white">Set expiration date & time</span>
        </label>
        {hasExpiry && (
          <div className="space-y-2">
            <input
              type="datetime-local"
              value={expiryDateTime}
              min={new Date().toISOString().slice(0, 16)}
              onChange={(e) => setExpiryDateTime(e.target.value)}
              className="w-full rounded-xl border border-ink-700 bg-ink-900 px-4 py-3 text-white focus:outline-none focus:border-white text-sm"
            />
            <p className="text-xs text-mist">
              This is converted to a ledger sequence at submit time (~5s per
              ledger on testnet).
            </p>
          </div>
        )}
      </section>

      {error && (
        <p className="rounded-xl border border-neutral-500/30 bg-neutral-500/10 px-4 py-3 text-sm text-neutral-400">
          {error}
        </p>
      )}

      <button
        type="button"
        onClick={handleSubmit}
        disabled={!canSubmit}
        className="w-full rounded-xl bg-white text-black border border-white py-3 text-sm font-semibold hover:bg-black hover:text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        {isSubmitting ? (
          <span className="flex items-center justify-center gap-2">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
            Issuing…
          </span>
        ) : (
          "Issue Attestation"
        )}
      </button>
    </div>
  );
}
