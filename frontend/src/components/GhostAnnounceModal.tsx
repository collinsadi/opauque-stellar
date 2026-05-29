import { useCallback, useEffect, useMemo, useState } from "react";
import { formatXlm, type Hex } from "../lib/stealth";
type Address = string;
import { readNativeBalance } from "../lib/readNativeBalance";
import type { ProtocolStep } from "./ProtocolStepper";
import { ProtocolStepper } from "./ProtocolStepper";
import type { OpaqueWasmModule } from "../hooks/useOpaqueWasm";
import type { MasterKeys } from "../lib/stealthLifecycle";
import {
  executeGhostOnchainAnnouncement,
  getAnnouncerAccount,
  type GhostAnnouncementProgress,
} from "../lib/stealthLifecycle";
import { useGhostAnnouncementStore } from "../store/ghostAnnouncementStore";
import { useGhostAddressStore } from "../store/ghostAddressStore";
import { useWatchlistStore } from "../hooks/useWatchlist";
import { ModalShell } from "./ModalShell";

type GhostAnnounceModalProps = {
  open: boolean;
  onClose: () => void;
  cluster: string;
  ghostStealthAddress: Address;
  ephemeralPrivKeyHex: Hex;
  stealthMetaAddressHex: Hex;
  wasm: OpaqueWasmModule;
  getMasterKeys: () => MasterKeys;
  announcerContract: Address;
  onAnnounced: () => void;
};

function progressToStep(p: GhostAnnouncementProgress): ProtocolStep {
  return {
    id: p.id,
    status: p.status,
    label: p.label,
    detail: p.detail,
  };
}

export function GhostAnnounceModal({
  open,
  onClose,
  cluster,
  ghostStealthAddress,
  ephemeralPrivKeyHex,
  stealthMetaAddressHex,
  wasm,
  getMasterKeys,
  announcerContract,
  onAnnounced,
}: GhostAnnounceModalProps) {
  const markAnnounced = useGhostAnnouncementStore((s) => s.markAnnounced);
  const [steps, setSteps] = useState<ProtocolStep[]>([]);
  const [running, setRunning] = useState(false);
  const [preflightError, setPreflightError] = useState<string | null>(null);
  const [announcerPreview, setAnnouncerPreview] = useState<string | null>(null);
  const [announcerBalance, setAnnouncerBalance] = useState<bigint | null>(null);

  const getNativeBalance = useCallback(
    (addr: Address) => readNativeBalance(addr),
    [],
  );

  const reset = useCallback(() => {
    setSteps([]);
    setRunning(false);
    setPreflightError(null);
    setAnnouncerPreview(null);
    setAnnouncerBalance(null);
  }, []);

  useEffect(() => {
    if (!open) {
      reset();
      return;
    }
    reset();

    let cancelled = false;
    (async () => {
      try {
        const masterKeys = getMasterKeys();
        const { address: announcerAddr } = getAnnouncerAccount(
          wasm,
          masterKeys,
          stealthMetaAddressHex,
        );
        if (cancelled) return;
        setAnnouncerPreview(announcerAddr);
        const bal = await getNativeBalance(announcerAddr);
        if (cancelled) return;
        setAnnouncerBalance(bal);
        const feeReserve = 500_000n;
        if (bal < feeReserve) {
          setPreflightError(
            `Announcer account (${announcerAddr}) needs at least ${formatXlm(feeReserve)} XLM for fees. Current balance: ${formatXlm(bal)} XLM. Fund it to proceed.`,
          );
        }
      } catch (e) {
        if (cancelled) return;
        setPreflightError(e instanceof Error ? e.message : String(e));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    open,
    stealthMetaAddressHex,
    ghostStealthAddress,
    ephemeralPrivKeyHex,
    announcerContract,
    wasm,
    getMasterKeys,
    getNativeBalance,
    reset,
  ]);

  void announcerContract;

  const canStart =
    !running &&
    !preflightError &&
    announcerBalance != null &&
    announcerBalance >= 500_000n;

  const handleStart = useCallback(async () => {
    if (!canStart) return;
    setRunning(true);
    setSteps([]);
    const upsert = (p: GhostAnnouncementProgress) => {
      const step = progressToStep(p);
      setSteps((prev) => {
        const i = prev.findIndex((s) => s.id === p.id);
        if (i < 0) return [...prev, step];
        const next = [...prev];
        next[i] = step;
        return next;
      });
    };

    try {
      await executeGhostOnchainAnnouncement(
        wasm,
        getMasterKeys,
        stealthMetaAddressHex,
        ghostStealthAddress,
        ephemeralPrivKeyHex,
        upsert,
      );
      markAnnounced(cluster, ghostStealthAddress);
      useGhostAddressStore.getState().remove(ghostStealthAddress, cluster);
      useWatchlistStore.getState().remove(cluster, ghostStealthAddress);
      onAnnounced();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      upsert({ id: "error", label: msg, status: "error" });
    } finally {
      setRunning(false);
    }
  }, [
    canStart,
    wasm,
    getMasterKeys,
    stealthMetaAddressHex,
    ghostStealthAddress,
    ephemeralPrivKeyHex,
    markAnnounced,
    cluster,
    onAnnounced,
  ]);

  const announcerHint = useMemo(() => {
    if (announcerBalance == null) return null;
    if (announcerBalance >= 500_000n)
      return "Announcer has enough SOL for fees.";
    return `Announcer needs more SOL (current: ${formatSol(announcerBalance)} SOL).`;
  }, [announcerBalance]);

  if (!open) return null;

  return (
    <ModalShell
      open
      title="Announce manual ghost"
      description="Publish an on-chain announcement so other devices and indexers can discover this address using your keys."
      onClose={onClose}
      closeOnBackdrop={!running}
      maxWidthClassName="max-w-lg"
      contentClassName="max-h-[90vh] overflow-y-auto"
    >
      <p className="text-sm text-mist mb-3">
        Right now this ghost address is only tracked in{" "}
        <strong className="text-neutral-200">this browser</strong>. Standard
        scanners and other devices cannot see it because no{" "}
        <strong className="text-neutral-200">on-chain announcement</strong> was
        published when you received funds.
      </p>
      <ul className="text-sm text-mist list-disc pl-5 space-y-1 mb-4">
        <li>
          Publishing an announcement lets indexers and Opaque on other devices
          discover this address using your keys, so you can{" "}
          <strong className="text-neutral-300">view and spend</strong> the funds
          anywhere—not only locally.
        </li>
        <li>
          The transaction will be sent from a dedicated stealth signer named{" "}
          <strong className="text-neutral-300">Announcer</strong>, so your{" "}
          <strong className="text-neutral-300">main connected wallet</strong> is
          not linked as the caller on-chain.
        </li>
      </ul>

      {preflightError && (
        <div className="mb-4 p-3 rounded-xl border border-error/30 bg-error/10 text-error text-sm">
          {preflightError}
        </div>
      )}

      {announcerPreview && (
        <p className="text-xs text-mist/70 font-mono break-all mb-2">
          Announcer address: {announcerPreview}
        </p>
      )}
      {announcerHint && (
        <p className="text-xs text-mist mb-4">{announcerHint}</p>
      )}

      <div className="mb-4">
        <p className="text-xs text-mist/70 uppercase tracking-wide mb-2">
          Flow
        </p>
        <ProtocolStepper
          steps={
            steps.length > 0
              ? steps
              : [
                  {
                    id: "1",
                    status: "wait",
                    label: "Verify ghost address and build announcement data",
                  },
                  {
                    id: "2",
                    status: "wait",
                    label:
                      "Prepare Announcer stealth signer (not your main wallet)",
                  },
                  {
                    id: "3",
                    status: "wait",
                    label: "Publish announcement to StealthAddressAnnouncer",
                  },
                  {
                    id: "4",
                    status: "wait",
                    label:
                      "Done — address discoverable with your keys on other devices",
                  },
                ]
          }
        />
      </div>

      <div className="flex flex-wrap gap-2 justify-end">
        <button
          type="button"
          disabled={running}
          onClick={onClose}
          className="px-4 py-2 rounded-xl text-sm font-medium text-mist border border-ink-600 bg-ink-950/30 hover:border-sol-purple/30 hover:text-white transition-colors disabled:opacity-40"
        >
          {steps.some((s) => s.status === "done") ? "Close" : "Cancel"}
        </button>
        <button
          type="button"
          disabled={!canStart}
          onClick={() => void handleStart()}
          className="px-4 py-2 rounded-xl text-sm font-semibold bg-sol-gradient text-white disabled:opacity-40 disabled:cursor-not-allowed hover:enabled:opacity-90"
        >
          {running ? "Working…" : "Start on-chain announcement"}
        </button>
      </div>
    </ModalShell>
  );
}
