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
import { useIssuedAttestationStore } from "../store/issuedAttestationStore";
import { getCluster } from "../lib/chain";
import { getExplorerTxUrl } from "../lib/explorer";
import { parseFieldDefs } from "../lib/schema";
import { encodeAttestationData } from "../lib/attestationV2";
import { computeStealthAddressAndViewTag } from "../lib/stealth";
import { hexToBytes, invokeAttest } from "../lib/programs";
import { addressToAuthorityBytes } from "../lib/schemaEncoding";
import { announceStealthTransfer, SCHEME_ID_SECP256K1 } from "../lib/contracts";
import { getFeatureFlags } from "../lib/featureFlags";
import { FeatureDisabledNotice } from "./FeatureDisabledNotice";
import { fetchAttestationUidForTransaction } from "../lib/chainSync";
import { isMetaAddressRecipient, recipientDiscoveryMessage } from "../lib/attestationRecipients";

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
  const [hasAnnouncement, setHasAnnouncement] = useState(false);
  const [announcementError, setAnnouncementError] = useState<string | null>(null);
  const [pendingAnnouncement, setPendingAnnouncement] = useState<{
    issuer: string;
    stealthAddress: string;
    ephemeralPubKey: Uint8Array;
    viewTag: number;
    schemaId: Uint8Array;
    uid: Uint8Array;
    expirySlot: number;
  } | null>(null);
  const [isRetryingAnnouncement, setIsRetryingAnnouncement] = useState(false);

  const uid = useId();

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

  const publishAnnouncement = async (request: NonNullable<typeof pendingAnnouncement>) => {
    if (!signTransaction) throw new Error("Wallet cannot sign announcement transactions.");
    const issuerBytes = addressToAuthorityBytes(request.issuer);
    const nonce = crypto.getRandomValues(new Uint8Array(32));
    const metadata = new Uint8Array(134);
    metadata[0] = request.viewTag;
    metadata[1] = 0xb2;
    metadata.set(request.schemaId, 2);
    metadata.set(issuerBytes, 34);
    metadata.set(request.uid, 66);
    metadata.set(nonce, 98);
    new DataView(metadata.buffer).setUint32(130, request.expirySlot >>> 0, false);
    await announceStealthTransfer({
      sourcePublicKey: request.issuer,
      schemeId: SCHEME_ID_SECP256K1,
      stealthAddress: hexToBytes(request.stealthAddress),
      ephemeralPubKey: request.ephemeralPubKey,
      metadata,
      signTransaction,
    });
  };

  const retryAnnouncement = async () => {
    if (!pendingAnnouncement) return;
    setIsRetryingAnnouncement(true);
    setAnnouncementError(null);
    try {
      await publishAnnouncement(pendingAnnouncement);
      setPendingAnnouncement(null);
      setHasAnnouncement(true);
    } catch (e) {
      setAnnouncementError(e instanceof Error ? e.message : "Announcement failed. Retry it.");
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
    if (!canSubmit || !selectedSchema || !publicKey) return;
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

      const toHex = (b: Uint8Array) =>
        "0x" +
        Array.from(b)
          .map((x) => x.toString(16).padStart(2, "0"))
          .join("");

      let uidBytes: Uint8Array | null = null;
      if (cluster) {
        for (let attempt = 0; attempt < 8 && !uidBytes; attempt++) {
          uidBytes = await fetchAttestationUidForTransaction(cluster, signature);
          if (!uidBytes && attempt < 7) {
            await new Promise((resolve) => setTimeout(resolve, 750));
          }
        }
      }
      if (!uidBytes) {
        setAnnouncementError("The attestation is confirmed, but its on-chain UID is not available yet. Refresh Manage before revoking or announcing it.");
      }

      // If we derived the stealth address from a meta-address, we have the ephemeral key
      // and can create an announcement so the recipient's scanner can discover this attestation.
      // The metadata MUST be the full V2 payload, or the scanner drops it:
      //   view_tag(1) || 0xB2(1) || schema_id(32) || issuer(32) || uid(32) || nonce(32) || expiry_be(4)
      if (uidBytes && ephemeralPubKey && stealthAddressHex && viewTag !== undefined) {
        const request = {
          issuer,
          stealthAddress: stealthAddressHex,
          ephemeralPubKey,
          viewTag,
          schemaId: schemaIdBytes,
          uid: uidBytes,
          expirySlot: expirySlotNum,
        };
        setPendingAnnouncement(request);
        try {
          await publishAnnouncement(request);
          setPendingAnnouncement(null);
          setHasAnnouncement(true);
        } catch (announceErr) {
          setAnnouncementError(announceErr instanceof Error ? announceErr.message : "Announcement failed. Retry it.");
        }
      }

      setTxSig(signature);

      // Record the issuance locally so the Manage page can list and revoke it.
      if (cluster && uidBytes) {
        let createdAtSlot = 0;
        try {
          createdAtSlot = await connection.getSlot();
        } catch {
          /* best effort, leave 0 */
        }
        useIssuedAttestationStore.getState().addIssued({
          cluster,
          uidHex: toHex(uidBytes),
          schemaIdHex: selectedSchema.schemaId,
          schemaName: selectedSchema.name,
          stealthAddressHashHex: toHex(stealthHashBytes),
          createdAtSlot,
          expirationSlot: expirySlotNum,
          isRevocable: selectedSchema.revocable,
          revoked: false,
          txHash: signature,
        });
      }

      // Log attestation issuance to transaction history
      if (cluster) {
        pushTx({
          cluster,
          kind: "trait",
          counterparty: recipientInput.trim(),
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
          {announcementError && (
            <div className="mt-3 space-y-2" role="alert">
              <p className="text-xs text-neutral-300">{pendingAnnouncement ? "Attestation issued, but announcement failed:" : "Attestation issued:"} {announcementError}</p>
              {pendingAnnouncement && (
                <button type="button" onClick={() => void retryAnnouncement()} disabled={isRetryingAnnouncement} className="rounded-lg border border-ink-700 bg-ink-900 px-3 py-1.5 text-xs text-white disabled:opacity-50">
                  {isRetryingAnnouncement ? "Retrying…" : "Retry announcement"}
                </button>
              )}
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
            setHasAnnouncement(false);
            setAnnouncementError(null);
            setPendingAnnouncement(null);
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
