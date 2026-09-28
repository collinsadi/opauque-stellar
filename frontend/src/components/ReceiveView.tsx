import { useState, useRef, useCallback } from "react";
import { QRCodeCanvas } from "qrcode.react";
import { useKeys } from "../context/KeysContext";
import { computeStealthAddressAndViewTag } from "../lib/stealth";
import { getCluster } from "../lib/chain";
import { useGhostAddressStore } from "../store/ghostAddressStore";
import { useWatchlistStore } from "../hooks/useWatchlist";
import { createPaymentLink, createWebPaymentLink } from "../lib/paymentLink";
import { RecoveryDocLink } from "./RecoveryDocLink";
import { BackupReminderModal } from "./security/BackupReminderModal";
import { useSecurityStore } from "../store/securityStore";
import { getFeatureFlags } from "../lib/featureFlags";
import { FeatureDisabledNotice } from "./FeatureDisabledNotice";

/** Detect the user's OS color-scheme preference for QR rendering. */
function prefersLightTheme(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ?? false;
}

type Mode = "choose" | "payment_link" | "manual_ghost";

function bytesToHex(b: Uint8Array): string {
  return "0x" + Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}

export function ReceiveView({ onBack }: { onBack: () => void }) {
  const { isSetup, stealthMetaAddressHex } = useKeys();
  const [mode, setMode] = useState<Mode>("choose");
  const [copiedMeta, setCopiedMeta] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const [copiedWebLink, setCopiedWebLink] = useState(false);
  const [copiedGhost, setCopiedGhost] = useState(false);
  const [copiedEphemeralKey, setCopiedEphemeralKey] = useState(false);
  const [ephemeralKeyRevealed, setEphemeralKeyRevealed] = useState(false);
  const [ghostResult, setGhostResult] = useState<{
    stealthAddress: string;
    ephemeralPrivKeyHex: string;
  } | null>(null);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const addGhost = useGhostAddressStore((s) => s.add);
  const watchlistAdd = useWatchlistStore((s) => s.add);
  const hasAcknowledgedReceiveRisk = useSecurityStore((s) => s.hasAcknowledgedReceiveRisk);
  const [showReceiveRiskModal, setShowReceiveRiskModal] = useState(false);
  const cluster = getCluster();
  const manualGhostEnabled = getFeatureFlags().manualGhostAddresses;
  const qrRef = useRef<HTMLCanvasElement>(null);
  const metaQrRef = useRef<HTMLCanvasElement>(null);
  const [qrTheme, setQrTheme] = useState<"dark" | "light">(prefersLightTheme() ? "light" : "dark");

  /** Export a clean PNG from a separate canvas (strips any browser-added metadata). */
  const downloadCleanPng = useCallback((source: HTMLCanvasElement, filename: string) => {
    const out = document.createElement("canvas");
    out.width = source.width;
    out.height = source.height;
    const ctx = out.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(source, 0, 0);
    out.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    }, "image/png");
  }, []);

  const handleDownloadQR = useCallback(() => {
    const canvas = qrRef.current;
    if (!canvas) return;
    downloadCleanPng(canvas, "stealth-address-qr.png");
  }, [downloadCleanPng]);

  const handleDownloadMetaQR = useCallback(() => {
    const canvas = metaQrRef.current;
    if (!canvas) return;
    downloadCleanPng(canvas, "meta-address-qr.png");
  }, [downloadCleanPng]);

  const handleCopy = useCallback(async (value: string, type: "meta" | "link" | "weblink" | "ghost" | "ephemeralKey") => {
    try {
      await navigator.clipboard.writeText(value);
      if (type === "meta") {
        setCopiedMeta(true);
        window.setTimeout(() => setCopiedMeta(false), 1200);
      } else if (type === "link") {
        setCopiedLink(true);
        window.setTimeout(() => setCopiedLink(false), 1200);
      } else if (type === "weblink") {
        setCopiedWebLink(true);
        window.setTimeout(() => setCopiedWebLink(false), 1200);
      } else if (type === "ephemeralKey") {
        setCopiedEphemeralKey(true);
        window.setTimeout(() => setCopiedEphemeralKey(false), 1200);
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
  const webPaymentLink = createWebPaymentLink(stealthMetaAddressHex, cluster);

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
              Browser-bound, back up ephemeral keys.{" "}
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
    const isDark = qrTheme === "dark";
    const qrBg = isDark ? "#000000" : "#ffffff";
    const qrFg = isDark ? "#ffffff" : "#000000";
    return (
      <div className="w-full">
        <h2 className="font-display text-xl font-bold text-white mb-1">Payment link</h2>
        <p className="text-sm text-mist mb-5">
          Share either your meta-address or link. Senders derive a unique stealth address per payment.{" "}
          <RecoveryDocLink section="payment-link">Recovery guide</RecoveryDocLink>
        </p>

        {/* Meta-address QR */}
        <div className="mb-4">
          <p className="text-[11px] uppercase tracking-wider text-mist/70 mb-2">Meta-address QR</p>
          <div className={`inline-block rounded-2xl p-4 ${isDark ? "bg-white" : "bg-ink-900 border border-ink-700"}`}>
            <QRCodeCanvas
              ref={metaQrRef}
              value={stealthMetaAddressHex}
              size={220}
              level="L"
              bgColor={qrBg}
              fgColor={qrFg}
              marginSize={2}
            />
          </div>
          <div className="flex items-center gap-2 mt-2">
            <button
              type="button"
              onClick={() => setQrTheme(isDark ? "light" : "dark")}
              className="rounded-xl border border-ink-600 bg-ink-950/30 px-3 py-1.5 text-xs font-medium text-mist transition-colors hover:border-white/30 hover:text-white"
            >
              {isDark ? "☀ Light theme" : "🌙 Dark theme"}
            </button>
            <button
              type="button"
              onClick={handleDownloadMetaQR}
              className="rounded-xl border border-ink-600 bg-ink-950/30 px-3 py-1.5 text-xs font-medium text-mist transition-colors hover:border-white/30 hover:text-white"
            >
              Download PNG
            </button>
          </div>
        </div>

        <div className="rounded-2xl border border-ink-700 bg-ink-900/25 p-4 mb-3">
          <p className="text-[11px] uppercase tracking-wider text-mist/70 mb-1">Meta-address</p>
          <div className="font-mono text-xs text-white/90 break-all">{stealthMetaAddressHex}</div>
        </div>
        <div className="rounded-2xl border border-ink-700 bg-ink-900/20 p-4 mb-3">
          <p className="text-[11px] uppercase tracking-wider text-mist/70 mb-1">Payment link (app)</p>
          <div className="font-mono text-xs text-mist break-all">{paymentLink}</div>
        </div>
        <div className="rounded-2xl border border-ink-700 bg-ink-900/20 p-4 mb-5">
          <p className="text-[11px] uppercase tracking-wider text-mist/70 mb-1">Web link (browser / chat / email)</p>
          <div className="font-mono text-xs text-mist break-all">{webPaymentLink}</div>
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
            className="rounded-xl bg-white border border-white px-3.5 py-2 text-sm font-semibold text-black hover:bg-black hover:text-white"
          >
            {copiedLink ? "Copied!" : "Copy app link"}
          </button>
          <button
            type="button"
            onClick={() => handleCopy(webPaymentLink, "weblink")}
            className="rounded-xl bg-white border border-white px-3.5 py-2 text-sm font-semibold text-black hover:bg-black hover:text-white"
          >
            {copiedWebLink ? "Copied!" : "Copy web link"}
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
        setGenerationError(null);
        try {
          const { stealthAddress, stealthStellarAddress, ephemeralPriv } = computeStealthAddressAndViewTag(stealthMetaAddressHex);
          const ephemeralPrivKeyHex = bytesToHex(ephemeralPriv);
          if (ephemeralPrivKeyHex == null || ephemeralPrivKeyHex === "") {
            setGenerationError("Ghost address generation failed: no ephemeral key produced. Please try again.");
            return;
          }
          addGhost({ cluster, stealthAddress, stealthStellarAddress, ephemeralPrivKeyHex });
          watchlistAdd(cluster, stealthAddress);
          setGhostResult({ stealthAddress, ephemeralPrivKeyHex });
          setEphemeralKeyRevealed(false);
        } catch (err) {
          const message = err instanceof Error ? err.message : "Unknown error during address generation";
          setGenerationError(`Ghost address generation failed: ${message}`);
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
            className="w-full rounded-xl bg-white border border-white px-4 py-3 text-sm font-semibold text-black hover:bg-black hover:text-white"
          >
            Generate ghost address
          </button>
          {generationError && (
            <div className="mt-4 p-3 rounded-xl border border-red-500/30 bg-red-500/10">
              <p className="text-sm text-red-300">{generationError}</p>
            </div>
          )}
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
        <div className="p-4 rounded-2xl bg-white inline-block mb-4">
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
            className="rounded-xl bg-white border border-white px-3.5 py-2 text-sm font-semibold text-black hover:bg-black hover:text-white"
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

        <div className="mt-6 p-4 rounded-2xl border border-orange-500/40 bg-orange-500/10">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-orange-300">Ephemeral Key Backup</h3>
            <button
              type="button"
              onClick={() => setEphemeralKeyRevealed(!ephemeralKeyRevealed)}
              className="text-xs font-medium text-orange-300 hover:text-orange-200 transition-colors"
            >
              {ephemeralKeyRevealed ? "Hide" : "Reveal"}
            </button>
          </div>
          <p className="text-xs text-orange-300/80 mb-3">
            This browser is the only place this address is stored. Back up the ephemeral key before closing this page or clearing your browser data.{" "}
            <RecoveryDocLink section="ghost-backup" className="text-orange-300 hover:underline font-medium">
              Learn how to backup
            </RecoveryDocLink>
          </p>
          {ephemeralKeyRevealed && (
            <>
              <div className="p-2 rounded-xl bg-ink-950/50 border border-ink-700 font-mono text-xs text-orange-200 break-all mb-3 max-h-24 overflow-y-auto">
                {ghostResult.ephemeralPrivKeyHex}
              </div>
              <button
                type="button"
                onClick={() => handleCopy(ghostResult.ephemeralPrivKeyHex, "ephemeralKey")}
                className="w-full rounded-xl border border-orange-500/50 bg-orange-500/10 px-3 py-2 text-xs font-medium text-orange-300 hover:border-orange-400 hover:text-orange-200 transition-colors"
              >
                {copiedEphemeralKey ? "Copied!" : "Copy ephemeral key"}
              </button>
            </>
          )}
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
