/**
 * ProveTraitModal — Selective disclosure flow for stealth attestations.
 *
 * Shows the user what will be shared (the trait/badge) and what stays hidden
 * (their wallet address, transaction history, stealth addresses). On confirmation,
 * triggers witness generation via WASM and proof generation via snarkjs.
 */

import { useState, useCallback, useRef } from "react";
import { useWallet } from "../hooks/useWallet";
const toHex = (n: bigint | number, opts?: { size?: number }) => {
  const hex = BigInt(n).toString(16);
  const padded = opts?.size ? hex.padStart(opts.size * 2, "0") : hex;
  return `0x${padded}`;
};
import { useReputationStore } from "../store/reputationStore";
import { useOpaqueWasm } from "../hooks/useOpaqueWasm";
import { useKeys } from "../context/KeysContext";
import { getExplorerTxUrl } from "../lib/explorer";
import {
  fetchLatestValidMerkleRoot,
  generateReputationProof,
  ProofGenerationCancelledError,
  submitProofOnChain,
} from "../lib/reputationProver";
import type { DiscoveredTrait, ProofData } from "../lib/reputation";
import { createPortableProof, exportProofToFile } from "../lib/proofExport";
import { ModalShell } from "./ModalShell";

type ProveTraitModalProps = {
  trait: DiscoveredTrait;
  onClose: () => void;
};

type ModalStep = "explain" | "generating" | "ready" | "submitting" | "submitted" | "error";

export function ProveTraitModal({ trait, onClose }: ProveTraitModalProps) {
  const { publicKey, signTransaction } = useWallet();
  const [step, setStep] = useState<ModalStep>("explain");
  const [txHash, setTxHash] = useState<string | null>(null);
  const { proofState, startProof, setProofStage, setProofError, setProofReady, resetProof } =
    useReputationStore();
  const { wasm } = useOpaqueWasm();
  const { getMasterKeys, isSetup } = useKeys();
  const proofAbortRef = useRef<AbortController | null>(null);

  const handleCancelGenerate = useCallback(() => {
    proofAbortRef.current?.abort();
    proofAbortRef.current = null;
    resetProof();
    setStep("explain");
  }, [resetProof]);

  const handleGenerate = useCallback(async () => {
    if (!wasm) {
      setProofError("WASM module not loaded");
      setStep("error");
      return;
    }
    if (!isSetup) {
      setProofError("Keys not set up. Sign in first.");
      setStep("error");
      return;
    }

    setStep("generating");
    startProof(trait.traitDef.id);
    const abortController = new AbortController();
    proofAbortRef.current = abortController;

    try {
      const masterKeys = getMasterKeys();
      const allTraits = useReputationStore.getState().discoveredTraits;
      const attestationsForWasm = allTraits.map((t) => ({
        stealth_address: t.stealthAddress,
        attestation_id: t.attestationId,
        tx_hash: t.txHash,
        block_number: t.blockNumber,
        ephemeral_pubkey: t.ephemeralPubkey ?? [],
      }));

      if (!trait.ephemeralPubkey || trait.ephemeralPubkey.length !== 33) {
        throw new Error("Trait is missing ephemeral pubkey. Please rescan announcements and try again.");
      }
      const stealthPrivKey = wasm.reconstruct_signing_key_wasm(
        masterKeys.spendPrivKey,
        masterKeys.viewPrivKey,
        new Uint8Array(trait.ephemeralPubkey)
      );

      // Deterministic external nullifier derived from attestation UID + user-controlled entropy.
      // attestation UID  = trait.attestationId (on-chain trait type identifier)
      // user entropy     = first 16 bytes of the stealth private key (controlled by wallet seeds)
      // Combined value fits comfortably within the BN254 scalar field (<2^254).
      const _uidN = BigInt(trait.attestationId);
      const _entN = Array.from(stealthPrivKey.slice(0, 16)).reduce(
        (a: bigint, b: number) => (a << 8n) | BigInt(b), 0n
      );
      const externalNullifier = String((_uidN << 128n) | _entN);

      const proofData = await generateReputationProof(
        wasm,
        trait,
        JSON.stringify(attestationsForWasm),
        stealthPrivKey,
        externalNullifier,
        (stage, percent) => setProofStage(stage, percent),
        abortController.signal,
      );

      // V2 public signals: [0]=merkle_root [1]=attestation_id [2]=external_nullifier [3]=nullifier_hash
      const rawRootSignal = proofData.publicSignals?.[0];
      if (rawRootSignal != null) {
        try {
          const merkleRootBytes32 = toHex(BigInt(rawRootSignal), { size: 32 });
          console.log("🌲 [Opaque] Merkle root ready", {
            rawSignal: rawRootSignal,
            bytes32Hex: merkleRootBytes32,
          });
        } catch (rootErr) {
          console.warn("🌲 [Opaque] Failed to convert Merkle root to bytes32", {
            rawSignal: rawRootSignal,
            error: rootErr,
          });
        }
      }

      setProofReady(proofData);
      setStep("ready");
    } catch (err) {
      if (err instanceof ProofGenerationCancelledError) {
        return;
      }
      const msg = err instanceof Error ? err.message : "Unknown error during proof generation";
      setProofError(msg);
      setStep("error");
    } finally {
      proofAbortRef.current = null;
    }
  }, [wasm, isSetup, trait, getMasterKeys, startProof, setProofStage, setProofError, setProofReady]);

  const handleSubmit = useCallback(async (merkleRootOverride?: string) => {
    const proof = proofState.proof;
    if (!proof) return;

    setStep("submitting");
    setProofStage("submitting", 50);

    try {
      if (!publicKey || !signTransaction) {
        throw new Error("Connect Freighter to submit the proof.");
      }
      // V2 public signals: [0]=merkle_root [2]=external_nullifier
      const merkleRoot = merkleRootOverride ?? proofState.proof?.publicSignals?.[0] ?? "0x0";
      const externalNullifier = proofState.proof?.publicSignals?.[2] ?? "0";

      const hash = await submitProofOnChain(proof, merkleRoot, externalNullifier, signTransaction, publicKey);
      setTxHash(hash);
      setProofStage("verified", 100);
      setStep("submitted");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "On-chain submission failed";
      setProofError(msg);
      setStep("error");
    }
  }, [proofState.proof, publicKey, signTransaction, setProofStage, setProofError]);

  const handleRetry = useCallback(async () => {
    // If a proof already exists, retry only the on-chain submission path.
    if (proofState.proof) {
      try {
        if (!publicKey) {
          throw new Error("Connect your wallet to retry proof submission.");
        }
        const latestRoot = await fetchLatestValidMerkleRoot(publicKey);
        const rootHex = `0x${Array.from(latestRoot)
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("")}`;
        await handleSubmit(rootHex);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Retry failed";
        setProofError(msg);
        setStep("error");
      }
      return;
    }
    await handleGenerate();
  }, [proofState.proof, publicKey, handleSubmit, handleGenerate, setProofError]);

  const handleClose = () => {
    resetProof();
    onClose();
  };

  return (
    <ModalShell
      open
      title={
        step === "explain"
          ? "Prove trait"
          : step === "generating"
            ? "Generating proof…"
            : step === "ready"
              ? "Proof ready"
              : step === "submitting"
                ? "Submitting…"
                : step === "submitted"
                  ? "Verified"
                  : "Proof failed"
      }
      description={
        step === "explain"
          ? "Generate a zero-knowledge proof locally, then optionally submit it on-chain."
          : null
      }
      onClose={handleClose}
      closeOnBackdrop={step !== "submitting" && step !== "generating"}
      maxWidthClassName="max-w-md"
    >
      {step === "explain" && (
        <ExplainStep trait={trait} onConfirm={handleGenerate} onCancel={handleClose} />
      )}
      {step === "generating" && (
        <GeneratingStep
          progress={proofState.progress}
          stage={proofState.stage}
          onCancel={handleCancelGenerate}
        />
      )}
      {step === "ready" && (
        <ReadyStep
          trait={trait}
          nullifier={proofState.proof?.nullifier ?? ""}
          proof={proofState.proof}
          onSubmit={handleSubmit}
          onClose={handleClose}
        />
      )}
      {step === "submitting" && <SubmittingStep />}
      {step === "submitted" && <SubmittedStep txHash={txHash} onClose={handleClose} />}
      {step === "error" && (
        <ErrorStep error={proofState.error} onRetry={handleRetry} onClose={handleClose} />
      )}
    </ModalShell>
  );
}

// =============================================================================
// Step components
// =============================================================================

function ExplainStep({
  trait,
  onConfirm,
  onCancel,
}: {
  trait: DiscoveredTrait;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div>
      <div className="rounded-xl border border-ink-700 bg-ink-950/40 p-4 mb-5">
        <div className="text-sm font-medium text-white mb-3">
          You are proving:
        </div>
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-lg bg-black/25 border border-white/25 flex items-center justify-center text-lg text-white">
            {trait.traitDef.icon === "code" ? "</>" : trait.traitDef.icon === "trending-up" ? "↗" : trait.traitDef.icon === "zap" ? "⚡" : trait.traitDef.icon === "shield" ? "🛡" : "◈"}
          </div>
          <div>
            <div className="font-semibold text-white text-sm">{trait.traitDef.label}</div>
            <div className="text-[11px] text-mist">{trait.traitDef.description}</div>
          </div>
        </div>

        <div className="space-y-2.5">
          <div className="flex items-start gap-2.5">
            <span className="text-white mt-0.5 shrink-0 text-xs">✓</span>
            <div>
              <div className="text-xs font-medium text-white">Shared (public)</div>
              <div className="text-[11px] text-mist">
                That you hold the "{trait.traitDef.label}" attestation for this specific action.
              </div>
            </div>
          </div>
          <div className="flex items-start gap-2.5">
            <span className="text-neutral-400 mt-0.5 shrink-0 text-xs">✗</span>
            <div>
              <div className="text-xs font-medium text-neutral-400">Hidden (private)</div>
              <div className="text-[11px] text-mist">
                Your main wallet address, stealth addresses, transaction history,
                balances, and all other traits.
              </div>
            </div>
          </div>
        </div>
      </div>

      <p className="text-[11px] text-mist/80 mb-4">
        A zero-knowledge proof will be generated locally in your browser. No data leaves your device
        until you explicitly submit the proof on-chain.
      </p>

      <div className="flex gap-3">
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 px-4 py-2.5 rounded-xl text-sm font-medium text-mist border border-ink-600 bg-ink-950/30 hover:border-white/30 hover:text-white transition-colors"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className="flex-1 px-4 py-2.5 rounded-xl text-sm font-semibold text-white bg-sol-gradient border border-transparent hover:opacity-90 transition-colors"
        >
          Generate Proof
        </button>
      </div>
    </div>
  );
}

function GeneratingStep({
  progress,
  stage,
  onCancel,
}: {
  progress: number;
  stage: string;
  onCancel: () => void;
}) {
  const label = stage === "preparing-witness"
    ? "Preparing witness from stealth history..."
    : "Generating ZK-SNARK proof (Groth16)...";

  return (
    <div className="text-center py-4">
      <div className="w-12 h-12 mx-auto mb-4 border-2 border-ink-600 border-t-white rounded-full animate-spin" aria-hidden />
      <p className="text-sm font-medium text-white mb-1">{label}</p>
      <p className="text-[11px] text-mist mb-4">
        Proof generation runs in a background worker so the UI stays responsive.
      </p>
      <div className="h-1.5 bg-ink-800 rounded-full overflow-hidden max-w-xs mx-auto">
        <div
          className="h-full bg-linear-to-r from-white to-white rounded-full transition-all duration-700 ease-out"
          style={{ width: `${progress}%` }}
        />
      </div>
      <p className="text-[10px] text-mist/70 mt-2">{progress}%</p>
      <button
        type="button"
        onClick={onCancel}
        className="mt-4 px-4 py-2 rounded-xl text-sm font-medium text-mist border border-ink-600 bg-ink-950/30 hover:border-white/30 hover:text-white transition-colors"
      >
        Cancel
      </button>
    </div>
  );
}

function ReadyStep({
  trait,
  nullifier,
  proof,
  onSubmit,
  onClose,
}: {
  trait: DiscoveredTrait;
  nullifier: string;
  proof: ProofData | null;
  onSubmit: () => void;
  onClose: () => void;
}) {
  const [copiedNullifier, setCopiedNullifier] = useState(false);
  const [copiedProof, setCopiedProof] = useState(false);
  const [exported, setExported] = useState(false);

  const handleCopyNullifier = () => {
    navigator.clipboard.writeText(nullifier).then(() => {
      setCopiedNullifier(true);
      setTimeout(() => setCopiedNullifier(false), 2000);
    });
  };

  const handleCopyProof = () => {
    if (!proof) return;
    navigator.clipboard.writeText(JSON.stringify(proof, null, 2)).then(() => {
      setCopiedProof(true);
      setTimeout(() => setCopiedProof(false), 2000);
    });
  };

  const handleExport = () => {
    if (!proof) return;
    const portable = createPortableProof({
      proof: proof.proof,
      publicSignals: proof.publicSignals,
      circuitVersion: "v1",
      nullifier: proof.nullifier,
      attestationId: proof.attestationId,
      externalNullifier: proof.publicSignals?.[4],
    });
    exportProofToFile(portable);
    setExported(true);
    setTimeout(() => setExported(false), 2000);
  };

  return (
    <div className="text-center py-2">
      <div className="w-14 h-14 mx-auto mb-4 rounded-full bg-neutral-400/10 border border-neutral-400/30 flex items-center justify-center">
        <span className="text-2xl text-neutral-300">✓</span>
      </div>
      <h4 className="text-sm font-semibold text-white mb-1">Proof Generated</h4>
      <p className="text-[11px] text-mist mb-4">
        Your "{trait.traitDef.label}" proof is ready. Submit it on-chain to verify
        your reputation without revealing your identity.
      </p>

      <div className="rounded-xl bg-ink-950/40 border border-ink-700 p-3 mb-4 text-left">
        <div className="text-[10px] text-mist/70 mb-1">Nullifier (unique per action)</div>
        <div className="flex items-center gap-2">
          <code className="text-[11px] text-slate-200 font-mono truncate flex-1">
            {nullifier}
          </code>
          <button
            type="button"
            onClick={handleCopyNullifier}
            className="text-[10px] text-mist/70 hover:text-white transition-colors shrink-0"
          >
            {copiedNullifier ? "Copied!" : "Copy"}
          </button>
        </div>
      </div>

      <div className="rounded-xl bg-ink-950/40 border border-ink-700 p-3 mb-4 text-left">
        <div className="text-[10px] text-mist/70 mb-2">Proof payload</div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={handleCopyProof}
            className="flex-1 px-3 py-2 rounded-xl text-xs font-medium text-mist border border-ink-600 bg-ink-950/30 hover:border-white/30 hover:text-white transition-colors"
          >
            {copiedProof ? "Copied proof JSON" : "Copy Proof JSON"}
          </button>
          <button
            type="button"
            onClick={handleExport}
            className="flex-1 px-3 py-2 rounded-xl text-xs font-medium text-mist border border-ink-600 bg-ink-950/30 hover:border-white/30 hover:text-white transition-colors"
          >
            {exported ? "Exported!" : "Export as File"}
          </button>
        </div>
      </div>

      <div className="flex gap-3">
        <button
          type="button"
          onClick={onClose}
          className="flex-1 px-4 py-2.5 rounded-xl text-sm font-medium text-mist border border-ink-600 bg-ink-950/30 hover:border-white/30 hover:text-white transition-colors"
        >
          Close
        </button>
        <button
          type="button"
          onClick={onSubmit}
          className="flex-1 px-4 py-2.5 rounded-xl text-sm font-semibold text-white bg-sol-gradient border border-transparent hover:opacity-90 transition-colors"
        >
          Submit On-Chain
        </button>
      </div>
    </div>
  );
}

function SubmittingStep() {
  return (
    <div className="text-center py-4">
      <div className="w-12 h-12 mx-auto mb-4 border-2 border-ink-600 border-t-white rounded-full animate-spin" aria-hidden />
      <p className="text-sm font-medium text-white mb-1">Submitting to verifier...</p>
      <p className="text-[11px] text-mist">
        Confirm the transaction in your wallet.
      </p>
    </div>
  );
}

function SubmittedStep({ txHash, onClose }: { txHash: string | null; onClose: () => void }) {
  return (
    <div className="text-center py-2">
      <div className="w-14 h-14 mx-auto mb-4 rounded-full bg-neutral-400/10 border border-neutral-400/30 flex items-center justify-center">
        <span className="text-2xl text-neutral-300">✓</span>
      </div>
      <h4 className="text-sm font-semibold text-white mb-1">Verified On-Chain!</h4>
      <p className="text-[11px] text-mist mb-4">
        Your reputation proof has been verified by the smart contract.
      </p>

      {txHash && (
        <div className="rounded-xl bg-ink-950/40 border border-ink-700 p-3 mb-4 text-left">
          <div className="text-[10px] text-mist/70 mb-1">Transaction</div>
          <a
            href={getExplorerTxUrl(txHash)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[11px] text-white underline decoration-white/40 underline-offset-2 hover:decoration-white font-mono truncate block"
          >
            {txHash.slice(0, 10)}...{txHash.slice(-8)}
          </a>
        </div>
      )}

      <button
        type="button"
        onClick={onClose}
        className="w-full px-4 py-2.5 rounded-xl text-sm font-semibold text-white bg-sol-gradient border border-transparent hover:opacity-90 transition-colors"
      >
        Done
      </button>
    </div>
  );
}

function ErrorStep({
  error,
  onRetry,
  onClose,
}: {
  error: string | null;
  onRetry: () => void;
  onClose: () => void;
}) {
  return (
    <div className="text-center py-4">
      <div className="w-12 h-12 mx-auto mb-4 rounded-full bg-neutral-500/10 border border-neutral-500/30 flex items-center justify-center">
        <span className="text-xl text-neutral-400">!</span>
      </div>
      <h4 className="text-sm font-semibold text-white mb-1">Proof Generation Failed</h4>
      <p className="text-[11px] text-neutral-400/80 mb-4">{error || "An unknown error occurred."}</p>
      <div className="flex gap-3">
        <button
          type="button"
          onClick={onClose}
          className="flex-1 px-4 py-2.5 rounded-xl text-sm font-medium text-mist border border-ink-600 bg-ink-950/30 hover:border-white/30 hover:text-white transition-colors"
        >
          Close
        </button>
        <button
          type="button"
          onClick={onRetry}
          className="flex-1 px-4 py-2.5 rounded-xl text-sm font-semibold text-white bg-sol-gradient border border-transparent hover:opacity-90 transition-colors"
        >
          Retry
        </button>
      </div>
    </div>
  );
}
