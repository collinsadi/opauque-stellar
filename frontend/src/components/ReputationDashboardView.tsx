/**
 * ReputationDashboardView — Displays discovered "Verified Traits" and lets
 * the user generate ZK proofs for selective disclosure.
 *
 * Traits are discovered by the Rust WASM scanner from announcement metadata.
 * When the user clicks "Prove Trait," a modal explains what will be shared
 * (the trait) vs what stays hidden (wallet, history). The WASM core then
 * generates a witness, and snarkjs creates the Groth16 proof in a background worker.
 */

import { useState, useCallback, useEffect } from "react";
import { getCluster } from "../lib/chain";
import { useReputationStore } from "../store/reputationStore";
import {
  KNOWN_TRAITS,
  getTraitByAttestationId,
  StealthAttestationArraySchema,
  type DiscoveredTrait,
  type ProofStage,
} from "../lib/reputation";
import { ProveTraitModal } from "./ProveTraitModal";
import { IssueTraitModal } from "./IssueTraitModal";
import { useOpaqueWasm } from "../hooks/useOpaqueWasm";
import { useKeys } from "../context/KeysContext";
import { getConfigForCluster } from "../contracts/contract-config";
import { useScanner } from "../hooks/useScanner";
import { useWallet } from "../hooks/useWallet";
import { useFreezeStatus } from "../hooks/useFreezeStatus";
import { FREEZE_STATUS_COPY } from "../lib/freezePolicy";

const ICONS: Record<string, string> = {
  code: "</> ",
  "trending-up": "↗ ",
  zap: "⚡ ",
  shield: "🛡 ",
  layers: "◈ ",
};

const CATEGORY_COLORS: Record<string, string> = {
  developer: "border-emerald-500/30 bg-emerald-500/5",
  trader: "border-amber-500/30 bg-amber-500/5",
  community: "border-violet-500/30 bg-violet-500/5",
  custom: "border-ink-600 bg-ink-900/20",
};

const CATEGORY_BADGES: Record<string, string> = {
  developer: "bg-emerald-500/20 text-emerald-400",
  trader: "bg-amber-500/20 text-amber-400",
  community: "bg-violet-500/20 text-violet-400",
  custom: "bg-neutral-500/20 text-neutral-400",
};

type ReputationDashboardViewProps = {
  onBack: () => void;
};

export function ReputationDashboardView({ onBack }: ReputationDashboardViewProps) {
  const { discoveredTraits, proofState } = useReputationStore();
  const [selectedTrait, setSelectedTrait] = useState<DiscoveredTrait | null>(null);
  const [showProveModal, setShowProveModal] = useState(false);
  const [showIssueModal, setShowIssueModal] = useState(false);
  const { wasm, isReady: wasmReady } = useOpaqueWasm();
  const { isSetup, getMasterKeys } = useKeys();
  const cluster = getCluster();
  const currentConfig = getConfigForCluster(cluster);
  const { connection, publicKey } = useWallet();
  const { status: freezeStatus, isLoading: freezeLoading } = useFreezeStatus(publicKey);
  const scanner = useScanner({
    cluster,
    publicClient: connection,
    announcerAddress: currentConfig?.announcerProgram ?? null,
    enabled: Boolean(wasmReady && cluster && currentConfig),
  });

  const handleProveTrait = useCallback((trait: DiscoveredTrait) => {
    setSelectedTrait(trait);
    setShowProveModal(true);
  }, []);

  const handleCloseModal = useCallback(() => {
    setShowProveModal(false);
    setSelectedTrait(null);
  }, []);

  const discoveredIds = new Set(discoveredTraits.map((t) => t.attestationId));
  const undiscoveredTraits = KNOWN_TRAITS.filter((t) => !discoveredIds.has(t.attestationId));

  useEffect(() => {
    if (!wasmReady || !wasm || !isSetup || scanner.announcements.length === 0) return;

    let masterKeys: ReturnType<typeof getMasterKeys>;
    try {
      masterKeys = getMasterKeys();
    } catch {
      return;
    }

    const jsonPayload = JSON.stringify(
      scanner.announcements.map((a) => ({
        stealthAddress: a.args?.stealthAddress ?? "",
        viewTag: parseInt((a.args?.metadata ?? "0x00").slice(2, 4), 16),
        ephemeralPubKey: a.args?.ephemeralPubKey ?? "0x",
        metadata: a.args?.metadata ?? "0x",
        txHash: a.transactionSignature,
        blockNumber: a.slot,
      }))
    );

    try {
      const resultJson = wasm.scan_attestations_wasm(
        jsonPayload,
        masterKeys.viewPrivKey,
        masterKeys.spendPubKey
      );
      const parsed = StealthAttestationArraySchema.safeParse(JSON.parse(resultJson));
      if (!parsed.success) return;
      const addDiscoveredTrait = useReputationStore.getState().addDiscoveredTrait;
      for (const att of parsed.data) {
        const traitDef =
          getTraitByAttestationId(att.attestation_id) ??
          {
            id: `custom-${att.attestation_id}`,
            attestationId: att.attestation_id,
            label: `Trait #${att.attestation_id}`,
            description: "Custom attestation",
            icon: "layers",
            category: "custom" as const,
          };
        addDiscoveredTrait({
          traitDef,
          attestationId: att.attestation_id,
          stealthAddress: att.stealth_address,
          txHash: att.tx_hash,
          blockNumber: att.block_number,
          discoveredAt: Date.now(),
          ephemeralPubkey: att.ephemeral_pubkey,
        });
      }
    } catch {
      // Keep the reputation view resilient if scanner parsing fails.
    }
  }, [wasmReady, wasm, isSetup, getMasterKeys, scanner.announcements]);

  const isFrozen = freezeStatus === "frozen";
  const freezeCopy = FREEZE_STATUS_COPY[freezeStatus];

  return (
    <div className="w-full">
      <div className="mb-8 flex flex-wrap items-end justify-between gap-3">
        <div className="flex items-end gap-3">
          <button
            type="button"
            onClick={onBack}
            className="rounded-lg p-2 text-mist/70 hover:text-white transition-colors"
            aria-label="Back"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <div>
            <h2 className="font-display text-2xl font-bold text-white">Reputation</h2>
            <p className="mt-1 text-sm text-mist">
              Prove verified traits with zero-knowledge—share eligibility, keep identity private.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setShowIssueModal(true)}
          className="rounded-xl bg-sol-gradient px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
        >
          Issue trait
        </button>
      </div>

      {/* Freeze / stale status banner (#85) */}
      {!freezeLoading && freezeStatus !== "active" && freezeStatus !== "unknown" && (
        <div
          role="alert"
          className={`mb-6 rounded-xl border px-4 py-3 text-sm ${
            isFrozen
              ? "border-red-500/40 bg-red-950/40 text-red-300"
              : "border-amber-500/30 bg-amber-950/30 text-amber-300"
          }`}
        >
          <p className="font-semibold mb-0.5">{freezeCopy.title}</p>
          <p className="text-xs opacity-80">{freezeCopy.detail}</p>
        </div>
      )}

      {/* Discovered traits */}
      {discoveredTraits.length > 0 && (
        <section className="mb-8">
          <h3 className="text-xs font-semibold text-mist/70 uppercase tracking-widest mb-3">
            Your Verified Traits
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {discoveredTraits.map((trait) => {
              const def = trait.traitDef;
              return (
                <div
                  key={`${trait.txHash}-${trait.attestationId}`}
                  className={`rounded-2xl border p-5 ${CATEGORY_COLORS[def.category]} transition-colors h-full`}
                >
                  <div className="flex h-full flex-col">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-lg" aria-hidden>
                          {ICONS[def.icon] || "● "}
                        </span>
                        <span className="font-display font-bold text-white">{def.label}</span>
                        <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${CATEGORY_BADGES[def.category]}`}>
                          {def.category}
                        </span>
                      </div>
                      <p className="text-sm text-mist mb-2">{def.description}</p>
                      <div className="flex items-center gap-3 text-[11px] text-mist/70 font-mono">
                        <span>Block #{trait.blockNumber}</span>
                        <span className="truncate max-w-[140px]" title={trait.txHash}>
                          tx: {trait.txHash.slice(0, 10)}...
                        </span>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleProveTrait(trait)}
                      disabled={
                        isFrozen ||
                        (proofState.stage !== "idle" && proofState.stage !== "error" && proofState.stage !== "verified")
                      }
                      title={isFrozen ? "Proof generation is disabled while the root is frozen" : undefined}
                      className="mt-4 w-full rounded-xl bg-sol-gradient px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {isFrozen ? "Frozen" : "Prove"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Empty state */}
      {discoveredTraits.length === 0 && (
        <div className="rounded-3xl border border-ink-700 bg-ink-900/25 p-10 text-center mb-8">
          <div className="text-3xl mb-3" aria-hidden>✦</div>
          <h3 className="font-display text-lg font-bold text-white mb-1">No traits yet</h3>
          <p className="text-sm text-mist max-w-sm mx-auto">
            Traits are automatically detected when scanning your stealth announcements.
            Use the Private Balance scanner to discover attestations in your history.
          </p>
        </div>
      )}

      {/* Undiscovered / available traits */}
      {undiscoveredTraits.length > 0 && (
        <section>
          <h3 className="text-xs font-semibold text-mist/70 uppercase tracking-widest mb-3">
            Available Traits
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {undiscoveredTraits.map((def) => (
              <div
                key={def.id}
                className="rounded-2xl border border-ink-700 bg-ink-900/15 p-5 opacity-55"
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-base" aria-hidden>
                    {ICONS[def.icon] || "● "}
                  </span>
                  <span className="font-display font-bold text-white text-sm">{def.label}</span>
                </div>
                <p className="text-[12px] text-mist/70">{def.description}</p>
                <span className="inline-block mt-3 text-[10px] text-mist/70 border border-ink-700 rounded-lg px-2 py-1 font-mono">
                  Not yet earned
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Proof generation status bar */}
      {proofState.stage !== "idle" && (
        <ProofProgressBar stage={proofState.stage} progress={proofState.progress} error={proofState.error} />
      )}

      {/* Prove modal */}
      {showProveModal && selectedTrait && (
        <ProveTraitModal trait={selectedTrait} onClose={handleCloseModal} />
      )}

      {/* Issue modal */}
      {showIssueModal && (
        <IssueTraitModal onClose={() => setShowIssueModal(false)} />
      )}
    </div>
  );
}

// =============================================================================
// Proof progress bar (shown at bottom of dashboard)
// =============================================================================

function ProofProgressBar({ stage, progress, error }: { stage: ProofStage; progress: number; error: string | null }) {
  const messages: Record<ProofStage, string> = {
    idle: "",
    "preparing-witness": "Preparing witness data...",
    "generating-proof": "Generating ZK-Proof...",
    "proof-ready": "Proof ready!",
    submitting: "Submitting to verifier...",
    verified: "Verified on-chain!",
    error: error || "Proof generation failed",
  };

  const isError = stage === "error";
  const isDone = stage === "proof-ready" || stage === "verified";

  return (
    <div className={`fixed bottom-20 left-4 right-4 md:left-auto md:right-6 z-40 max-w-sm md:ml-auto rounded-2xl border px-4 py-3 shadow-2xl backdrop-blur-lg ${
      isError
        ? "border-red-500/30 bg-red-950/40"
        : isDone
          ? "border-emerald-500/30 bg-emerald-950/40"
          : "border-ink-700 bg-ink-900/95"
    }`}>
      <div className="flex items-center gap-3">
        {!isDone && !isError && (
          <div className="w-5 h-5 border-2 border-ink-600 border-t-sol-purple rounded-full animate-spin shrink-0" aria-hidden />
        )}
        {isDone && <span className="text-emerald-400 shrink-0" aria-hidden>✓</span>}
        {isError && <span className="text-red-400 shrink-0" aria-hidden>✗</span>}
        <div className="flex-1 min-w-0">
          <p className={`text-xs font-medium ${isError ? "text-red-300" : isDone ? "text-emerald-300" : "text-white"}`}>
            {messages[stage]}
          </p>
          {!isDone && !isError && (
            <div className="mt-1.5 h-1 bg-ink-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-sol-purple/40 rounded-full transition-all duration-500"
                style={{ width: `${progress}%` }}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
