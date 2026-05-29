/**
 * Schema Studio — V2 Schema Registration UI
 *
 * Allows issuers to define and register attestation schemas on-chain.
 * A schema specifies the field layout, revocability, optional expiry,
 * and an optional resolver program for custom attestation logic.
 */

import { useState, useId } from "react";
import { useWallet } from "../hooks/useWallet";
import {
  fieldDefsToString,
  prepareRegisterSchema,
  SCHEMA_RENT_STROOPS,
  type FieldDef,
  type FieldType,
} from "../lib/schema";
import { invokeRegisterSchema, bytesToHex } from "../lib/programs";
import { getExplorerTxUrl } from "../lib/explorer";
import { getSorobanServer } from "../lib/stellar";
import { useSchemaStore } from "../store/schemaStore";

// =============================================================================
// Constants
// =============================================================================

const FIELD_TYPES: FieldType[] = [
  "bool",
  "u8",
  "u16",
  "u32",
  "u64",
  "string",
  "pubkey",
];

type ResolverType = "none" | "whitelist" | "payment" | "nft" | "custom";

const RESOLVER_OPTIONS: {
  value: ResolverType;
  label: string;
  description: string;
}[] = [
  {
    value: "none",
    label: "No resolver",
    description: "Anyone with authority can attest",
  },
  {
    value: "whitelist",
    label: "Whitelist resolver",
    description: "Only approved wallets can issue",
  },
  {
    value: "payment",
    label: "Payment resolver",
    description: "Issuers pay a fee per attestation",
  },
  {
    value: "nft",
    label: "NFT Gate resolver",
    description: "Recipient must hold a collection NFT",
  },
  {
    value: "custom",
    label: "Custom address",
    description: "Provide your own resolver program ID",
  },
];

// =============================================================================
// Component
// =============================================================================

export function SchemaStudio() {
  const { address: walletAddress, publicKey, signTransaction } = useWallet();
  const addSchema = useSchemaStore((s) => s.addSchema);

  const [name, setName] = useState("");
  const [fields, setFields] = useState<FieldDef[]>([
    { id: crypto.randomUUID(), name: "", type: "bool" },
  ]);
  const [revocable, setRevocable] = useState(true);
  const [hasExpiry, setHasExpiry] = useState(false);
  const [expiryDateTime, setExpiryDateTime] = useState("");
  const [resolverType, setResolverType] = useState<ResolverType>("none");
  const [customResolver, setCustomResolver] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [txSig, setTxSig] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const uid = useId();

  const fieldDefsString = fieldDefsToString(fields);
  const nameValid = name.trim().length > 0 && name.length <= 64;
  const fieldDefsValid = fieldDefsString.length <= 256;
  const canSubmit =
    walletAddress != null &&
    publicKey != null &&
    nameValid &&
    fieldDefsValid &&
    !isSubmitting;

  const addField = () => {
    setFields((prev) => [
      ...prev,
      { id: crypto.randomUUID(), name: "", type: "bool" },
    ]);
  };

  const updateField = (id: string, update: Partial<FieldDef>) => {
    setFields((prev) =>
      prev.map((f) => (f.id === id ? { ...f, ...update } : f)),
    );
  };

  const removeField = (id: string) => {
    setFields((prev) => prev.filter((f) => f.id !== id));
  };

  const handleSubmit = async () => {
    if (!walletAddress || !publicKey || !canSubmit) return;
    setIsSubmitting(true);
    setError(null);
    setTxSig(null);

    try {
      const authority = publicKey;
      const trimmedName = name.trim();
      const resolverAddr =
        resolverType === "custom" && customResolver
          ? customResolver.trim()
          : null;
      let expiryLedger = 0;
      if (hasExpiry) {
        if (!expiryDateTime) {
          throw new Error("Please select a schema expiration date and time.");
        }
        const targetMs = Date.parse(expiryDateTime);
        if (!Number.isFinite(targetMs)) {
          throw new Error("Invalid schema expiration date/time.");
        }
        const nowMs = Date.now();
        if (targetMs <= nowMs) {
          throw new Error("Schema expiration date/time must be in the future.");
        }
        const latest = await getSorobanServer().getLatestLedger();
        const ledgersUntilExpiry = Math.ceil((targetMs - nowMs) / 5000);
        expiryLedger = latest.sequence + Math.max(1, ledgersUntilExpiry);
      }

      const { schemaId, schemaKey, canonicalFieldDefs } =
        await prepareRegisterSchema(authority, trimmedName, fieldDefsString);

      if (!signTransaction) throw new Error("Wallet cannot sign transactions.");

      const signature = await invokeRegisterSchema({
        authority,
        schemaId,
        name: trimmedName,
        fieldDefinitions: canonicalFieldDefs,
        revocable,
        resolver: resolverAddr,
        schemaExpiryLedger: expiryLedger,
        signTransaction,
      });

      const schemaIdHex = bytesToHex(schemaId);

      addSchema({
        address: schemaKey,
        schemaId: schemaIdHex,
        authority: walletAddress,
        resolver: resolverAddr ?? "",
        revocable,
        name: trimmedName,
        fieldDefinitions: canonicalFieldDefs,
        version: 1,
        delegates: [],
        createdAt: Date.now(),
        schemaExpiryLedger: expiryLedger,
        schemaExpirySlot: expiryLedger,
        deprecated: false,
      });

      setTxSig(signature);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to register schema");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (txSig) {
    return (
      <div className="flex flex-col items-center justify-center gap-6 py-12 px-4 text-center">
        <div className="w-12 h-12 rounded-full bg-green-500/10 flex items-center justify-center">
          <svg
            className="w-6 h-6 text-green-400"
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
          <p className="text-white font-semibold text-lg">Schema registered</p>
          <p className="text-mist text-sm mt-1">
            <strong className="text-white">{name}</strong> is now live on-chain.
          </p>
          <a
            href={getExplorerTxUrl(txSig)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-sol-purple hover:underline mt-2 inline-block font-mono"
          >
            {txSig.slice(0, 20)}… ↗
          </a>
        </div>
        <button
          type="button"
          onClick={() => {
            setTxSig(null);
            setName("");
            setFields([{ id: crypto.randomUUID(), name: "", type: "bool" }]);
            setHasExpiry(false);
            setExpiryDateTime("");
          }}
          className="rounded-xl bg-ink-800 px-6 py-2.5 text-sm font-medium text-white hover:bg-ink-700 transition-colors"
        >
          Register another schema
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-8 space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-white">Schema Studio</h1>
        <p className="text-mist text-sm mt-1">
          Define the template for a class of attestations and control who can
          issue them.
        </p>
      </div>

      {/* Schema Name */}
      <section className="space-y-2">
        <label
          htmlFor={`${uid}-name`}
          className="block text-sm font-medium text-white"
        >
          Schema Name <span className="text-red-400">*</span>
        </label>
        <input
          id={`${uid}-name`}
          type="text"
          maxLength={64}
          placeholder='e.g. "KYC Verified", "High Volume Trader"'
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full rounded-xl border border-ink-700 bg-ink-900 px-4 py-3 text-white placeholder-ink-500 focus:outline-none focus:border-sol-purple text-sm"
        />
        <p className="text-xs text-ink-500">{name.length}/64 characters</p>
      </section>

      {/* Field Definitions */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <label className="block text-sm font-medium text-white">
            Field Definitions <span className="text-red-400">*</span>
          </label>
          <button
            type="button"
            onClick={addField}
            className="text-xs font-medium text-sol-purple hover:text-sol-purple/80 transition-colors"
          >
            + Add Field
          </button>
        </div>

        <div className="space-y-2">
          {fields.map((field) => (
            <div key={field.id} className="flex gap-2 items-center">
              <input
                type="text"
                placeholder="field name"
                value={field.name}
                onChange={(e) =>
                  updateField(field.id, { name: e.target.value })
                }
                className="flex-1 rounded-xl border border-ink-700 bg-ink-900 px-3 py-2.5 text-white placeholder-ink-500 focus:outline-none focus:border-sol-purple text-sm"
              />
              <select
                value={field.type}
                onChange={(e) =>
                  updateField(field.id, { type: e.target.value as FieldType })
                }
                className="rounded-xl border border-ink-700 bg-ink-900 px-3 py-2.5 text-white focus:outline-none focus:border-sol-purple text-sm"
              >
                {FIELD_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => removeField(field.id)}
                disabled={fields.length <= 1}
                className="rounded-lg p-2 text-ink-500 hover:text-red-400 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                aria-label="Remove field"
              >
                ×
              </button>
            </div>
          ))}
        </div>

        {fieldDefsString && (
          <p className="text-xs text-mist font-mono bg-ink-900 rounded-lg px-3 py-2 border border-ink-800">
            Preview: <span className="text-sol-purple">{fieldDefsString}</span>
          </p>
        )}
        {!fieldDefsValid && (
          <p className="text-xs text-red-400">
            Field definitions exceed 256 characters.
          </p>
        )}
      </section>

      {/* Settings */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium text-white">Settings</h2>
        <div className="rounded-xl border border-ink-700 bg-ink-900 divide-y divide-ink-800">
          <label className="flex items-center justify-between px-4 py-3 cursor-pointer">
            <div>
              <span className="text-sm text-white">Revocable</span>
              <p className="text-xs text-mist mt-0.5">
                Allow attestations to be revoked by the authority
              </p>
            </div>
            <input
              type="checkbox"
              checked={revocable}
              onChange={(e) => setRevocable(e.target.checked)}
              className="h-4 w-4 accent-sol-purple"
            />
          </label>
          <label className="flex items-center justify-between px-4 py-3 cursor-pointer">
            <div>
              <span className="text-sm text-white">Schema Expiry</span>
              <p className="text-xs text-mist mt-0.5">
                Pick date & time — no new attestations after that moment
              </p>
            </div>
            <input
              type="checkbox"
              checked={hasExpiry}
              onChange={(e) => setHasExpiry(e.target.checked)}
              className="h-4 w-4 accent-sol-purple"
            />
          </label>
        </div>
        {hasExpiry && (
          <div className="space-y-2">
            <input
              type="datetime-local"
              value={expiryDateTime}
              min={new Date().toISOString().slice(0, 16)}
              onChange={(e) => setExpiryDateTime(e.target.value)}
              className="w-full rounded-xl border border-ink-700 bg-ink-900 px-4 py-3 text-white focus:outline-none focus:border-sol-purple text-sm"
            />
            <p className="text-xs text-mist">
              Converted to a ledger sequence at submit time (~5s per ledger on
              testnet).
            </p>
          </div>
        )}
      </section>

      {/* Resolver */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium text-white">Resolver (optional)</h2>
        <div className="space-y-2">
          {RESOLVER_OPTIONS.map((opt) => (
            <label
              key={opt.value}
              className={`flex items-start gap-3 rounded-xl border px-4 py-3 cursor-pointer transition-colors ${
                resolverType === opt.value
                  ? "border-sol-purple bg-sol-purple/5"
                  : "border-ink-700 bg-ink-900 hover:border-ink-600"
              }`}
            >
              <input
                type="radio"
                name={`${uid}-resolver`}
                value={opt.value}
                checked={resolverType === opt.value}
                onChange={() => setResolverType(opt.value)}
                className="mt-0.5 accent-sol-purple"
              />
              <div>
                <span className="text-sm font-medium text-white">
                  {opt.label}
                </span>
                <p className="text-xs text-mist mt-0.5">{opt.description}</p>
              </div>
            </label>
          ))}
        </div>
        {resolverType === "custom" && (
          <input
            type="text"
            placeholder="Resolver program ID (base58)"
            value={customResolver}
            onChange={(e) => setCustomResolver(e.target.value)}
            className="w-full rounded-xl border border-ink-700 bg-ink-900 px-4 py-3 text-white placeholder-ink-500 focus:outline-none focus:border-sol-purple text-sm font-mono"
          />
        )}
      </section>

      {/* Cost estimate */}
      <p className="text-xs text-mist">
        Estimated reserve: ~{(Number(SCHEMA_RENT_LAMPORTS) / 1e7).toFixed(4)}{" "}
        XLM (Soroban storage)
      </p>

      {error && (
        <p className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {error}
        </p>
      )}

      <button
        type="button"
        onClick={handleSubmit}
        disabled={!canSubmit}
        className="w-full rounded-xl bg-sol-purple py-3 text-sm font-semibold text-white hover:bg-sol-purple/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        {isSubmitting ? (
          <span className="flex items-center justify-center gap-2">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
            Registering…
          </span>
        ) : (
          "Register Schema"
        )}
      </button>

      {!walletAddress && (
        <p className="text-center text-xs text-mist">
          Connect your wallet to register a schema.
        </p>
      )}
    </div>
  );
}
