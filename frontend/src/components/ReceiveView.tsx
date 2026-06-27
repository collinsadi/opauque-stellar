import { useState, useRef, useCallback, useEffect } from "react";
import { QRCodeCanvas } from "qrcode.react";
import { useKeys } from "../context/KeysContext";
import { computeStealthAddressAndViewTag } from "../lib/stealth";
import { getCluster } from "../lib/chain";
import { useGhostAddressStore } from "../store/ghostAddressStore";
import { useWatchlistStore } from "../hooks/useWatchlist";
import { createPaymentLink } from "../lib/paymentLink";
import { RecoveryDocLink } from "./RecoveryDocLink";
import { BackupReminderModal } from "./security/BackupReminderModal";
import { useSecurityStore } from "../store/securityStore";
import { getFeatureFlags } from "../lib/featureFlags";
import { FeatureDisabledNotice } from "./FeatureDisabledNotice";
import { makeOpaquePaymentLink } from "../lib/deepLinks";

type Mode = "choose" | "payment_link" | "manual_ghost";

function bytesToHex(b: Uint8Array): string {
  return "0x" + Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}

export function ReceiveView({ initialMode, onBack }: { initialMode?: Extract<Mode, "payment_link">; onBack: () => void }) {
  const { isSetup, stealthMetaAddressHex } = useKeys();
  const [mode, setMode] = useState<Mode>("choose");
  const [copiedMeta, setCopiedMeta] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const [copiedOpaqueLink, setCopiedOpaqueLink] = useState(false);
  const [copiedGhost, setCopiedGhost] = useState(false);
  const [ghostResult, setGhostResult] = useState<{
    stealthAddress: string;
    ephemeralPrivKeyHex: string;
  } | null>(null);
  const addGhost = useGhostAddressStore((s) => s.add);
  const watchlistAdd = useWatchlistStore((s) => s.add);
  const hasAcknowledgedReceiveRisk = useSecurityStore((s) => s.hasAcknowledgedReceiveRisk);
  const [showReceiveRiskModal, setShowReceiveRiskModal] = useState(false);
  const cluster = getCluster();
  const manualGhostEnabled = getFeatureFlags().manualGhostAddresses;
  const qrRef = useRef<HTMLCanvasElement>(null);
  const handleDownloadQR = useCallback(() => {
    const canvas = qrRef.current;
    if (!canvas) return;
    const url = canvas.toDataURL("image/png");
    const a = document.createElement("a");
    a.href = url;
    a.download = "stealth-address-qr.png";
    a.click();
  }, []);

  useEffect(() => {
    if (initialMode) setMode(initialMode);
  }, [initialMode]);

  const handleCopy = useCallback(async (value: string, type: "meta" | "link" | "opaque" | "ghost") => {
    try {
      await navigator.clipboard.writeText(value);
      if (type === "meta") {
        setCopiedMeta(true);
        window.setTimeout(() => setCopiedMeta(false), 1200);
      } else if (type === "link") {
        setCopiedLink(true);
        window.setTimeout(() => setCopiedLink(false), 1200);
      } else if (type === "opaque") {
        setCopiedOpaqueLink(true);
        window.setTimeout(() => setCopiedOpaqueLink(false), 1200);
      } else {
        setCopiedGhost(true);
        window.setTimeout(() => setCopiedGhost(false), 1200);
      }
    } catch {
      // ignore
    }
  }, []);

  if (!isSetup || !stealthMetaAddressHex) {
    return (
      <div className="card max-w-lg mx-auto text-center text-neutral-500">
        Complete setup first.
      </div>
    );
  }

  const paymentLink = createPaymentLink(stealthMetaAddressHex, cluster);
  const opaquePaymentLink = makeOpaquePaymentLink(stealthMetaAddressHex);

  if (mode === "choose") {
    return (
      <div className="w-full">
        <div className="mb-8">
          <h2 className="font-display text-2xl font-bold text-white">Receive</h2>
          <p className="mt-1 text-sm text-mist">
            Choose how you want to receive payments privately.
          </p>
        </div>
        <div className={`grid grid-cols-1 gap-4 ${manualGhostEnabled ? "sm:grid-cols-2" : ""}`}>
          <button
            type="button"
            onClick={() => setMode("payment_link")}
            className="group rounded-2xl border border-ink-700 bg-ink-900/25 p-5 text-left transition-all hover:border-white/30 hover:bg-ink-900/40 hover:border-white"
          >
            <span className="inline-flex items-center rounded-lg bg-black/30 px-2 py-1 text-[11px] font-medium text-white mb-3">
              Recommended
            </span>
            <span className="font-display text-base font-bold text-white block mb-1.5">Payment link</span>
            <p className="text-sm text-mist leading-relaxed">
              Share your permanent meta-address link. Recovery works across devices once keys are restored.
            </p>
            <p className="mt-2 text-xs text-mist/80">
              <RecoveryDocLink section="payment-link">How payment-link recovery works</RecoveryDocLink>
            </p>
            <p className="mt-4 text-xs font-medium text-mist/70 transition-colors group-hover:text-white">Open flow →</p>
          </button>
          {manualGhostEnabled && (
          <button
            type="button"
            onClick={() => {
              if (!hasAcknowledgedReceiveRisk) {
                setShowReceiveRiskModal(true);
                return;
              }
              setMode("manual_ghost");
            }}
            className="group rounded-2xl border border-ink-700 bg-ink-900/25 p-5 text-left transition-all hover:border-white/30 hover:bg-ink-900/40 hover:border-white"
          >
            <span className="inline-flex items-center rounded-lg bg-neutral-500/15 px-2 py-1 text-[11px] font-medium text-neutral-400 mb-3">
              One-time
            </span>
            <span className="font-display text-base font-bold text-white block mb-1.5">Manual ghost address</span>
            <p className="text-sm text-mist leading-relaxed">
              Generate a fast one-time receive address locally without requiring announcer interaction.
            </p>
            <p className="mt-2 text-xs text-neutral-300/90">
              Browser-bound — back up ephemeral keys.{" "}
              <RecoveryDocLink section="manual-ghost" className="text-neutral-300 hover:underline font-medium">
                Read before using
              </RecoveryDocLink>
            </p>
            <p className="mt-4 text-xs font-medium text-mist/70 transition-colors group-hover:text-white">Open flow →</p>
          </button>
          )}
        </div>
        {showReceiveRiskModal && (
          <BackupReminderModal
            type="receive"
            onProceed={() => {
              setShowReceiveRiskModal(false);
              setMode("manual_ghost");
            }}
            onCancel={() => setShowReceiveRiskModal(false)}
          />
        )}
        <button
          type="button"
          onClick={onBack}
          className="mt-6 rounded-xl border border-ink-600 bg-ink-950/30 px-4 py-2 text-sm font-medium text-mist transition-colors hover:border-white/30 hover:text-white"
        >
          Back
        </button>
      </div>
    );
  }

  if (mode === "payment_link") {
    return (
      <div className="w-full">
        <h2 className="font-display text-xl font-bold text-white mb-1">Payment link</h2>
        <p className="text-sm text-mist mb-5">
          Share either your meta-address or link. Senders derive a unique stealth address per payment.{" "}
          <RecoveryDocLink section="payment-link">Recovery guide</RecoveryDocLink>
        </p>
        <div className="rounded-2xl border border-ink-700 bg-ink-900/25 p-4 mb-3">
          <p className="text-[11px] uppercase tracking-wider text-mist/70 mb-1">Meta-address</p>
          <div className="font-mono text-xs text-white/90 break-all">{stealthMetaAddressHex}</div>
        </div>
        <div className="rounded-2xl border border-ink-700 bg-ink-900/20 p-4 mb-5">
          <p className="text-[11px] uppercase tracking-wider text-mist/70 mb-1">Web payment link</p>
          <div className="font-mono text-xs text-mist break-all">{paymentLink}</div>
        </div>
        <div className="rounded-2xl border border-ink-700 bg-ink-900/20 p-4 mb-5">
          <p className="text-[11px] uppercase tracking-wider text-mist/70 mb-1">Opaque app link</p>
          <div className="font-mono text-xs text-mist break-all">{opaquePaymentLink}</div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => handleCopy(stealthMetaAddressHex, "meta")}
            className="rounded-xl border border-ink-600 bg-ink-950/30 px-3.5 py-2 text-sm font-medium text-mist transition-colors hover:border-white/30 hover:text-white"
          >
            {copiedMeta ? "Copied!" : "Copy meta-address"}
          </button>
          <button
            type="button"
            onClick={() => handleCopy(paymentLink, "link")}
            className="rounded-xl bg-sol-gradient border border-transparent px-3.5 py-2 text-sm font-semibold text-white hover:opacity-90"
          >
            {copiedLink ? "Copied!" : "Copy web link"}
          </button>
          <button
            type="button"
            onClick={() => handleCopy(opaquePaymentLink, "opaque")}
            className="rounded-xl border border-ink-600 bg-ink-950/30 px-3.5 py-2 text-sm font-medium text-mist transition-colors hover:border-white/30 hover:text-white"
          >
            {copiedOpaqueLink ? "Copied!" : "Copy opaque link"}
          </button>
        </div>
        <button
          type="button"
          onClick={() => setMode("choose")}
          className="mt-6 rounded-xl border border-ink-600 bg-ink-950/30 px-4 py-2 text-sm font-medium text-mist transition-colors hover:border-white/30 hover:text-white"
        >
          Back
        </button>
      </div>
    );
  }

  if (mode === "manual_ghost") {
    if (!manualGhostEnabled) {
      return (
        <div className="w-full">
          <button
            type="button"
            onClick={() => setMode("choose")}
            className="mb-4 rounded-xl border border-ink-600 bg-ink-950/30 px-4 py-2 text-sm font-medium text-mist transition-colors hover:border-white/30 hover:text-white"
          >
            Back
          </button>
          <FeatureDisabledNotice feature="manualGhostAddresses" />
        </div>
      );
    }
    if (!ghostResult) {
      const generate = () => {
        try {
          const { stealthAddress, ephemeralPriv } = computeStealthAddressAndViewTag(stealthMetaAddressHex);
          const ephemeralPrivKeyHex = bytesToHex(ephemeralPriv);
          if (ephemeralPrivKeyHex == null || ephemeralPrivKeyHex === "") {
            console.error("[Opaque] Ghost address key generation produced no ephemeral key.");
            return;
          }
          addGhost({ cluster, stealthAddress, ephemeralPrivKeyHex });
          watchlistAdd(cluster, stealthAddress);
          setGhostResult({ stealthAddress, ephemeralPrivKeyHex });
        } catch (err) {
          console.error("[Opaque] Ghost address key generation failed:", err);
        }
      };
      return (
        <div className="w-full">
          <h2 className="font-display text-xl font-bold text-white mb-1">Manual ghost address</h2>
          <p className="text-sm text-mist mb-5">
            Generate a one-time stealth address. Derivation data is saved locally so the app can monitor and claim incoming funds.{" "}
            <RecoveryDocLink section="manual-ghost">What you must back up</RecoveryDocLink>
          </p>
          <button
            type="button"
            onClick={generate}
            className="w-full rounded-xl bg-sol-gradient border border-transparent px-4 py-3 text-sm font-semibold text-white hover:opacity-90"
          >
            Generate ghost address
          </button>
          <button
            type="button"
            onClick={() => setMode("choose")}
            className="mt-4 rounded-xl border border-ink-600 bg-ink-950/30 px-4 py-2 text-sm font-medium text-mist transition-colors hover:border-white/30 hover:text-white"
          >
            Back
          </button>
        </div>
      );
    }

    return (
      <div className="w-full">
        <div className="mb-4 px-4 py-3 rounded-2xl border border-neutral-500/40 bg-neutral-500/10">
          <p className="text-sm font-medium text-neutral-300">Manual ghost address</p>
          <p className="text-xs text-neutral-300/80 mt-1">
            Because the sender is not using the protocol announcer, this address is only discoverable by this specific browser. Back up the ephemeral key before sharing this address.{" "}
            <RecoveryDocLink section="ghost-backup" className="text-neutral-300 hover:underline font-medium">
              Ghost backup guide
            </RecoveryDocLink>
          </p>
        </div>
        <p className="mb-4 px-4 py-3 rounded-2xl border border-ink-700 bg-ink-900/30 text-mist text-sm">
          Receiving from outside Opaque? If you share this 0x address directly, Opaque will track it locally in this browser. To see these funds on other devices, import the ghost entry with its ephemeral key.{" "}
          <RecoveryDocLink section="device-migration">Device migration steps</RecoveryDocLink>
        </p>
        <h2 className="font-display text-xl font-bold text-white mb-1">Your ghost address</h2>
        <p className="text-sm text-mist mb-4">
          Share this address with the sender. It is stored locally; the app will detect incoming payments.
        </p>
        <div className="p-4 rounded-2xl inline-block mb-4" style={{ backgroundColor: "#ffffff" }}>
          <QRCodeCanvas
            ref={qrRef}
            value={ghostResult.stealthAddress}
            size={200}
            level="M"
            bgColor="#ffffff"
            fgColor="#000000"
            marginSize={2}
          />
        </div>
        <div className="p-3 rounded-xl bg-ink-900/30 border border-ink-700 font-mono text-xs text-mist break-all mb-4">
          {ghostResult.stealthAddress}
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => handleCopy(ghostResult.stealthAddress, "ghost")}
            className="rounded-xl bg-sol-gradient border border-transparent px-3.5 py-2 text-sm font-semibold text-white hover:opacity-90"
          >
            {copiedGhost ? "Copied!" : "Copy address"}
          </button>
          <button
            type="button"
            onClick={handleDownloadQR}
            className="rounded-xl border border-ink-600 bg-ink-950/30 px-3.5 py-2 text-sm font-medium text-mist transition-colors hover:border-white/30 hover:text-white"
          >
            Download QR Code
          </button>
        </div>
        <button
          type="button"
          onClick={() => setMode("choose")}
          className="mt-6 rounded-xl border border-ink-600 bg-ink-950/30 px-4 py-2 text-sm font-medium text-mist transition-colors hover:border-white/30 hover:text-white"
        >
          Back
        </button>
      </div>
    );
  }

  return null;
}
