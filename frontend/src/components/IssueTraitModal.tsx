/**
 * IssueTraitModal — Issue a stealth attestation trait to any recipient.
 *
 * The user enters a recipient's stealth meta-address (or resolves from registry),
 * picks a trait, and the modal calls StealthAddressAnnouncer.announce() with
 * attestation metadata embedded in the metadata field.
 */

import { useState, useCallback } from "react";
import { useWallet } from "../hooks/useWallet";
import { getCluster } from "../lib/chain";
import { getExplorerTxUrl } from "../lib/explorer";
import { computeStealthAddressAndViewTag } from "../lib/stealth";
import { announceStealthTransfer, SCHEME_ID_SECP256K1 } from "../lib/contracts";
import { getConfigForCluster } from "../contracts/contract-config";
import { KNOWN_TRAITS } from "../lib/reputation";
import { ModalShell } from "./ModalShell";
import { useTxHistoryStore } from "../store/txHistoryStore";

type IssueTraitModalProps = {
  onClose: () => void;
};

type IssueStep = "form" | "confirming" | "success" | "error";

const ATTESTATION_MARKER = 0xa7;

function encodeAttestationMetadata(
  viewTag: number,
  attestationId: number,
): Uint8Array {
  const buf = new Uint8Array(10);
  buf[0] = viewTag;
  buf[1] = ATTESTATION_MARKER;
  const view = new DataView(buf.buffer);
  // Write attestation_id as big-endian u64 (high 32 + low 32)
  view.setUint32(2, 0);
  view.setUint32(6, attestationId);
  return buf;
}

export function IssueTraitModal({ onClose }: IssueTraitModalProps) {
  const { publicKey, signTransaction } = useWallet();
  const cluster = getCluster();
  const pushTx = useTxHistoryStore((s) => s.push);
  const [step, setStep] = useState<IssueStep>("form");
  const [recipientMeta, setRecipientMeta] = useState("");
  const [selectedTraitId, setSelectedTraitId] = useState<string>(
    KNOWN_TRAITS[0]?.id ?? "",
  );
  const [customLabel, setCustomLabel] = useState("");
  const [customAttestationId, setCustomAttestationId] = useState("");
  const [useCustom, setUseCustom] = useState(false);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedTrait = KNOWN_TRAITS.find((t) => t.id === selectedTraitId);
  const attestationId = useCustom
    ? parseInt(customAttestationId, 10) || 0
    : (selectedTrait?.attestationId ?? 0);

  const canSubmit = recipientMeta.length >= 132 && attestationId > 0;

  const handleIssue = useCallback(async () => {
    if (!canSubmit || !publicKey) {
      if (!publicKey) setError("Connect your wallet first.");
      return;
    }

    setStep("confirming");
    setError(null);

    try {
      const config = getConfigForCluster(cluster);
      if (!config) throw new Error("Cluster not supported");

      const { stealthAddress, ephemeralPubKey, viewTag } =
        computeStealthAddressAndViewTag(recipientMeta as `0x${string}`);

      const metadata = encodeAttestationMetadata(viewTag, attestationId);

      const stealthAddrBytes = Uint8Array.from(
        Buffer.from(stealthAddress.replace(/^0x/i, ""), "hex"),
      );
      const sig = await announceStealthTransfer({
        sourcePublicKey: publicKey,
        schemeId: SCHEME_ID_SECP256K1,
        stealthAddress: stealthAddrBytes,
        ephemeralPubKey,
        metadata,
        signTransaction,
      });

      const traitLabel = useCustom
        ? customLabel.trim() || `Trait #${attestationId}`
        : (selectedTrait?.label ?? `Trait #${attestationId}`);
      const recipientLabel =
        recipientMeta.length > 14
          ? `${recipientMeta.slice(0, 10)}…${recipientMeta.slice(-4)}`
          : recipientMeta;
      pushTx({
        cluster,
        kind: "trait",
        counterparty: recipientLabel,
        amountStroops: "0",
        tokenSymbol: "TRAIT",
        tokenAddress: null,
        amount: traitLabel,
        txHash: sig,
      });

      setTxHash(sig);
      setStep("success");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Transaction failed");
      setStep("error");
    }
  }, [
    canSubmit,
    cluster,
    recipientMeta,
    attestationId,
    pushTx,
    publicKey,
    signTransaction,
    useCustom,
    customLabel,
    selectedTrait,
  ]);

  return (
    <ModalShell
      open
      title={
        step === "form"
          ? "Issue trait"
          : step === "confirming"
            ? "Confirming…"
            : step === "success"
              ? "Trait issued"
              : "Failed"
      }
      description={
        step === "form"
          ? "Publish an attestation announcement to a recipient meta-address."
          : null
      }
      onClose={onClose}
      closeOnBackdrop={step !== "confirming"}
      maxWidthClassName="max-w-md"
    >
      {step === "form" && (
        <div>
          {/* Recipient meta-address */}
          <label className="block text-xs font-medium text-mist mb-1.5">
            Recipient Stealth Meta-Address
          </label>
          <input
            type="text"
            value={recipientMeta}
            onChange={(e) => setRecipientMeta(e.target.value.trim())}
            placeholder="0x02abc...def (132 hex chars)"
            className="w-full px-3 py-2.5 rounded-xl bg-ink-950/40 border border-ink-700 text-sm text-white placeholder-ink-600 focus:border-sol-purple/30 focus:outline-none font-mono text-[11px] mb-4"
          />

          {/* Trait selection */}
          <label className="block text-xs font-medium text-mist mb-1.5">
            Trait to Issue
          </label>

          {!useCustom ? (
            <div className="space-y-2 mb-3">
              {KNOWN_TRAITS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setSelectedTraitId(t.id)}
                  className={`w-full text-left px-3 py-2.5 rounded-lg border transition-colors ${
                    selectedTraitId === t.id
                      ? "border-sol-purple/35 bg-sol-purple-muted/10"
                      : "border-ink-700 bg-ink-950/30 hover:border-ink-600"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-sm text-white font-medium">
                        {t.label}
                      </span>
                      <span className="text-[10px] text-mist/70 ml-2">
                        ID: {t.attestationId}
                      </span>
                    </div>
                    {selectedTraitId === t.id && (
                      <span className="text-emerald-400 text-xs">✓</span>
                    )}
                  </div>
                  <p className="text-[11px] text-mist mt-0.5">
                    {t.description}
                  </p>
                </button>
              ))}
            </div>
          ) : (
            <div className="space-y-3 mb-3">
              <input
                type="text"
                value={customLabel}
                onChange={(e) => setCustomLabel(e.target.value)}
                placeholder="Custom trait name"
                className="w-full px-3 py-2 rounded-xl bg-ink-950/40 border border-ink-700 text-sm text-white placeholder-ink-600 focus:border-sol-purple/30 focus:outline-none"
              />
              <input
                type="number"
                value={customAttestationId}
                onChange={(e) => setCustomAttestationId(e.target.value)}
                placeholder="Attestation ID (number)"
                min="1"
                className="w-full px-3 py-2 rounded-xl bg-ink-950/40 border border-ink-700 text-sm text-white placeholder-ink-600 focus:border-sol-purple/30 focus:outline-none"
              />
            </div>
          )}

          <button
            type="button"
            onClick={() => setUseCustom(!useCustom)}
            className="text-[11px] text-mist/70 hover:text-white transition-colors mb-4 block"
          >
            {useCustom ? "← Back to known traits" : "Issue a custom trait →"}
          </button>

          {/* Summary */}
          {canSubmit && (
            <div className="rounded-xl bg-ink-950/40 border border-ink-700 p-3 mb-4">
              <div className="text-[10px] text-mist/70 mb-1">Will issue</div>
              <div className="text-xs text-white font-medium">
                {useCustom
                  ? customLabel || `Custom #${customAttestationId}`
                  : selectedTrait?.label}
                <span className="text-mist/70 ml-1">(ID: {attestationId})</span>
              </div>
              <div className="text-[10px] text-mist/70 mt-1">
                To: {recipientMeta.slice(0, 14)}...{recipientMeta.slice(-8)}
              </div>
            </div>
          )}

          <div className="flex gap-3">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2.5 rounded-xl text-sm font-medium text-mist border border-ink-600 bg-ink-950/30 hover:border-sol-purple/30 hover:text-white transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleIssue}
              disabled={!canSubmit}
              className="flex-1 px-4 py-2.5 rounded-xl text-sm font-semibold text-white bg-sol-gradient hover:opacity-90 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              Issue Trait
            </button>
          </div>
        </div>
      )}

      {step === "confirming" && (
        <div className="text-center py-6">
          <div
            className="w-12 h-12 mx-auto mb-4 border-2 border-ink-600 border-t-sol-purple rounded-full animate-spin"
            aria-hidden
          />
          <p className="text-sm font-medium text-white mb-1">
            Sending announcement...
          </p>
          <p className="text-[11px] text-mist">
            Confirm the transaction in your wallet.
          </p>
        </div>
      )}

      {step === "success" && (
        <div className="text-center py-4">
          <div className="w-14 h-14 mx-auto mb-4 rounded-full bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center">
            <span className="text-2xl text-emerald-400">✓</span>
          </div>
          <h4 className="text-sm font-semibold text-white mb-1">
            Trait issued
          </h4>
          <p className="text-[11px] text-mist mb-4">
            The recipient's scanner will discover this attestation on their next
            scan.
          </p>
          {txHash && cluster && (
            <a
              href={getExplorerTxUrl(txHash) ?? "#"}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-[11px] text-sol-purple underline decoration-sol-purple/40 underline-offset-2 hover:decoration-sol-purple mb-4"
            >
              View on Explorer
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                <polyline points="15 3 21 3 21 9" />
                <line x1="10" y1="14" x2="21" y2="3" />
              </svg>
            </a>
          )}
          <button
            type="button"
            onClick={onClose}
            className="w-full px-4 py-2.5 rounded-xl text-sm font-semibold text-white bg-sol-gradient hover:opacity-90 transition-colors"
          >
            Done
          </button>
        </div>
      )}

      {step === "error" && (
        <div className="text-center py-4">
          <div className="w-12 h-12 mx-auto mb-4 rounded-full bg-red-500/10 border border-red-500/30 flex items-center justify-center">
            <span className="text-xl text-red-400">!</span>
          </div>
          <h4 className="text-sm font-semibold text-white mb-1">
            Failed to Issue Trait
          </h4>
          <p className="text-[11px] text-red-400/80 mb-4">{error}</p>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2.5 rounded-xl text-sm font-medium text-mist border border-ink-600 bg-ink-950/30 hover:border-sol-purple/30 hover:text-white transition-colors"
            >
              Close
            </button>
            <button
              type="button"
              onClick={() => setStep("form")}
              className="flex-1 px-4 py-2.5 rounded-xl text-sm font-semibold text-white bg-sol-gradient hover:opacity-90 transition-colors"
            >
              Try Again
            </button>
          </div>
        </div>
      )}
    </ModalShell>
  );
}
