/**
 * Proof Generator Modal — V2
 *
 * Generates a Groth16 ZK proof for a discovered V2 trait, entirely in the browser.
 * No private data leaves the user's device. The proof can then be submitted on-chain
 * to the groth16_verifier program's verify_proof_v2 instruction.
 */

import { useState, useRef, useCallback } from "react";
import type { V2DiscoveredTrait } from "../store/schemaStore";
import { useWallet } from "../hooks/useWallet";
import { invokeVerifyProofV2, hexToBytes, hexPubkeyToBase58 } from "../lib/programs";
import { useOpaqueWasm } from "../hooks/useOpaqueWasm";
import { useKeys } from "../context/KeysContext";
import { getAnnouncementsForCluster } from "../lib/opaqueCache";
import { getCluster } from "../lib/chain";
import { fetchLatestValidMerkleRoot } from "../lib/reputationProver";
import { getExplorerTxUrl } from "../lib/explorer";
import { getDemoVerifierUrl } from "../lib/featureFlags";
import {
  generateV2ProofInWorker,
  ProofGenerationCancelledError,
  type ProofWorkerStage,
} from "../lib/proofWorker/proofWorkerClient";
import { createPortableProof, exportProofToFile } from "../lib/proofExport";
import { useProofHistoryStore, type ProofHistoryStatus } from "../store/proofHistoryStore";

// =============================================================================
// Types
// =============================================================================

type ProofStep = "setup" | "generating" | "done" | "submitting" | "verified" | "error";

interface GeneratedProof {
  proof: {
    pi_a: string[];
    pi_b: string[][];
    pi_c: string[];
  };
  publicSignals: string[];
  nullifierHash: string;
  schemaId: string;
}

// =============================================================================
// Helpers
// =============================================================================

function bigIntToBytes32BE(val: bigint): Uint8Array {
  const bytes = new Uint8Array(32);
  let n = val;
  for (let i = 31; i >= 0; i--) {
    bytes[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return bytes;
}

function stringToBigInt(s: string): bigint {
  if (s.startsWith("0x") || s.startsWith("0X")) return BigInt(s);
  return BigInt(s);
}

// =============================================================================
// Component
// =============================================================================

interface ProofGeneratorModalProps {
  trait: V2DiscoveredTrait;
  onClose: () => void;
}

export function ProofGeneratorModal({ trait, onClose }: ProofGeneratorModalProps) {
  const { publicKey, signTransaction } = useWallet();
  const { wasm, isReady: wasmReady } = useOpaqueWasm();
  const { isSetup, getMasterKeys } = useKeys();
  const [step, setStep] = useState<ProofStep>("setup");
  const [externalNullifier, setExternalNullifier] = useState("");
  const [proof, setProof] = useState<GeneratedProof | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [txSig, setTxSig] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [progressStage, setProgressStage] = useState<ProofWorkerStage>("preparing-witness");
  const upsertProofHistory = useProofHistoryStore((s) => s.upsert);
  const proofAbortRef = useRef<AbortController | null>(null);

  const recordProofHistory = useCallback(
    (
      proofData: GeneratedProof,
      status: ProofHistoryStatus,
      opts: { txHash?: string; error?: string } = {},
    ) => {
      const cluster = getCluster() || "unknown";
      upsertProofHistory({
        cluster,
        schemaId: proofData.schemaId,
        schemaName: trait.schemaName ?? "Unknown Schema",
        nullifierHash: proofData.nullifierHash,
        externalNullifier: proofData.publicSignals[2] ?? "",
        merkleRoot: proofData.publicSignals[0] ?? "",
        attestationId: proofData.publicSignals[1] ?? "",
        txHash: opts.txHash,
        status,
        error: opts.error,
        source: status === "verified" ? "on-chain" : "local",
      });
    },
    [trait.schemaName, upsertProofHistory],
  );

  const handleCancelGenerate = useCallback(() => {
    proofAbortRef.current?.abort();
    proofAbortRef.current = null;
    setProgress(0);
    setStep("setup");
  }, []);

  const handleGenerate = async () => {
    if (trait.chainDiscoveryOnly) {
      setError(
        "Proof generation is unavailable for this attestation. It was discovered on-chain " +
          "without a V2 announcement (0xB2 metadata marker), which is required to obtain the " +
          "leaf nonce for the ZK circuit. Ask the issuer to re-announce the attestation, then rescan."
      );
      setStep("error");
      return;
    }
    if (!externalNullifier.trim()) {
      setError("External nullifier is required.");
      return;
    }
    if (!isSetup) {
      setError("Keys not set up. Please sign in first.");
      return;
    }
    if (!wasmReady || !wasm) {
      setError("WASM module not ready. Please wait and try again.");
      return;
    }

    setStep("generating");
    setError(null);
    setProgress(0);
    setProgressStage("preparing-witness");
    const abortController = new AbortController();
    proofAbortRef.current = abortController;

    try {
      // ── Look up the announcement to get the ephemeral public key ──────────
      const cluster = getCluster();
      if (!cluster) throw new Error("No cluster configured.");

      const announcements = await getAnnouncementsForCluster(cluster);
      const announcement = announcements.find(
        (a) => a.transactionSignature === trait.txHash
      );
      if (!announcement?.args?.ephemeralPubKey) {
        throw new Error(
          "Announcement not found for this trait (txHash: " +
            trait.txHash.slice(0, 20) +
            "…). Try rescanning."
        );
      }

      const ephemeralPubKeyHex = announcement.args.ephemeralPubKey;
      const ephemeralPubKeyBytes = hexToBytes(ephemeralPubKeyHex);
      if (ephemeralPubKeyBytes.length !== 33) {
        throw new Error(
          `Invalid ephemeral public key length: expected 33 bytes, got ${ephemeralPubKeyBytes.length}`
        );
      }

      const masterKeys = getMasterKeys();
      const stealthPrivKeyBytes = wasm.reconstruct_signing_key_wasm(
        masterKeys.spendPrivKey,
        masterKeys.viewPrivKey,
        ephemeralPubKeyBytes,
      );

      const { proof: snarkProof, publicSignals } = await generateV2ProofInWorker(
        {
          stealthPrivKeyBytes: Array.from(stealthPrivKeyBytes),
          schemaIdField: trait.merkleLeafPreimage.schemaIdField,
          issuerPkX: trait.merkleLeafPreimage.issuerPkX,
          nonceField: trait.merkleLeafPreimage.nonceField,
          externalNullifierStr: externalNullifier,
          traitDataHex: trait.dataHex,
        },
        {
          signal: abortController.signal,
          onProgress: (stage, percent) => {
            setProgressStage(stage);
            setProgress(percent);
          },
        },
      );

      const generatedProof: GeneratedProof = {
        proof: {
          pi_a: snarkProof.pi_a.slice(0, 2),
          pi_b: snarkProof.pi_b.slice(0, 2),
          pi_c: snarkProof.pi_c.slice(0, 2),
        },
        publicSignals,
        nullifierHash: publicSignals[3] ?? "0",
        schemaId: trait.schemaId,
      };

      setProof(generatedProof);
      recordProofHistory(generatedProof, "generated");
      setStep("done");
    } catch (e) {
      if (e instanceof ProofGenerationCancelledError) {
        return;
      }
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("Circuit files could not be loaded")) {
        setError(
          `${msg} For V2, run the trusted setup and copy WASM + zkey to frontend/public/circuits/v2/. See next_steps.md Phase 1.`,
        );
      } else {
        setError(msg);
      }
      setStep("error");
    } finally {
      proofAbortRef.current = null;
    }
  };

  const handleCopy = async () => {
    if (!proof) return;
    await navigator.clipboard.writeText(JSON.stringify(proof, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSubmitOnChain = async () => {
    if (!proof || !publicKey) {
      setError("Connect wallet to submit proof on-chain.");
      return;
    }
    setStep("submitting");
    setError(null);

    try {
      const piA = proof.proof.pi_a.map((s) => stringToBigInt(s));
      const piBFlat = proof.proof.pi_b.flatMap((pair) => [
        stringToBigInt(pair[1]),
        stringToBigInt(pair[0]),
      ]);
      const piC = proof.proof.pi_c.map((s) => stringToBigInt(s));

      const proofA = new Uint8Array(64);
      proofA.set(bigIntToBytes32BE(piA[0]), 0);
      proofA.set(bigIntToBytes32BE(piA[1]), 32);

      const proofB = new Uint8Array(128);
      for (let i = 0; i < 4; i++) {
        proofB.set(bigIntToBytes32BE(piBFlat[i]), i * 32);
      }

      const proofC = new Uint8Array(64);
      proofC.set(bigIntToBytes32BE(piC[0]), 0);
      proofC.set(bigIntToBytes32BE(piC[1]), 32);

      // Fetch the latest on-chain Merkle root and validate against proof
      const fetchedRootBytes = await fetchLatestValidMerkleRoot(publicKey);
      // Convert fetched bytes to bigint for comparison
      const fetchedRootBigInt = (() => {
        let v = 0n;
        for (const b of fetchedRootBytes) {
          v = (v << 8n) + BigInt(b);
        }
        return v;
      })();
      const proofRootBigInt = stringToBigInt(proof.publicSignals[0]);
      if (fetchedRootBigInt !== proofRootBigInt) {
        const details = "Merkle root mismatch: proof does not correspond to current on-chain root.";
        recordProofHistory(proof, "failed", { error: details });
        setError(details);
        setStep("error");
        return;
      }
      const merkleRoot = fetchedRootBytes;
      const attestationId = bigIntToBytes32BE(
        stringToBigInt(proof.publicSignals[1])
      );
      const extNullifier = bigIntToBytes32BE(
        stringToBigInt(proof.publicSignals[2])
      );
      const nullifierHash = bigIntToBytes32BE(
        stringToBigInt(proof.publicSignals[3])
      );

      const signature = await invokeVerifyProofV2({
        caller: publicKey,
        proofA,
        proofB,
        proofC,
        merkleRoot,
        attestationId,
        externalNullifier: extNullifier,
        nullifierHash,
        signTransaction,
      });

      setTxSig(signature);
      recordProofHistory(proof, "verified", { txHash: signature });
      setStep("verified");
    } catch (e) {
      const details = e instanceof Error ? e.message : "On-chain verification failed";
      recordProofHistory(proof, "failed", { error: details });
      setError(`Soroban proof verification failed: ${details}`);
      setStep("error");
    }
  };

  const issuerBase58 = hexPubkeyToBase58(trait.issuer);
  const issuerShort = `${issuerBase58.slice(0, 6)}…${issuerBase58.slice(-4)}`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-lg rounded-2xl border border-ink-700 bg-ink-900 shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-ink-800">
          <h2 className="text-base font-semibold text-white">Generate ZK Proof</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-ink-500 hover:text-white transition-colors text-xl leading-none"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-5">
          {/* Trait info */}
          <div className="rounded-xl border border-ink-700 bg-ink-950 px-4 py-3 space-y-1">
            <p className="text-xs text-mist">Proving schema</p>
            <p className="text-sm font-semibold text-white">{trait.schemaName ?? "Unknown Schema"}</p>
            <p className="text-xs text-ink-500 font-mono truncate">{trait.schemaId}</p>
            <p className="text-xs text-mist mt-1">
              Issued by:{" "}
              <span className="text-white font-mono">
                {issuerShort}
              </span>
            </p>
          </div>

          {step === "setup" && (
            <>
              {/* WASM loading state — shown while cryptography module initialises */}
              {!wasmReady && (
                <div
                  className="flex items-center gap-3 rounded-xl border border-ink-700 bg-ink-950/50 px-4 py-3"
                  aria-live="polite"
                  aria-label="Loading cryptography module"
                >
                  <span
                    className="h-4 w-4 shrink-0 animate-spin rounded-full border border-ink-600 border-t-white"
                    aria-hidden
                  />
                  <span className="text-xs text-mist">Loading cryptography module…</span>
                </div>
              )}

              <div className="space-y-2">
                <label className="block text-sm font-medium text-white">
                  External Nullifier
                </label>
                <input
                  type="text"
                  placeholder="Decimal or 0x-hex domain separator from the requesting dApp"
                  value={externalNullifier}
                  onChange={(e) => setExternalNullifier(e.target.value)}
                  className="w-full rounded-xl border border-ink-700 bg-ink-950 px-4 py-3 text-white placeholder-ink-500 focus:outline-none focus:border-white text-sm font-mono"
                />
                <p className="text-xs text-mist">
                  Must be a decimal number or 0x-prefixed hex (e.g. <span className="font-mono text-ink-400">1</span> or <span className="font-mono text-ink-400">0x01</span>).
                  Prevents replay across different applications.
                </p>
              </div>

              {error && (
                <p className="text-sm text-neutral-400">{error}</p>
              )}

              <button
                type="button"
                onClick={handleGenerate}
                disabled={!externalNullifier.trim() || !wasmReady}
                className="w-full rounded-xl bg-sol-gradient text-white border border-transparent py-3 text-sm font-semibold hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {!wasmReady ? "Loading cryptography module…" : "Generate Proof in Browser"}
              </button>

              <p className="text-center text-xs text-ink-500">
                No private data leaves your browser. Proof generation takes 10–60 seconds.
              </p>
            </>
          )}

          {step === "generating" && (
            <div className="flex flex-col items-center gap-4 py-6">
              <span className="h-10 w-10 animate-spin rounded-full border-2 border-ink-600 border-t-white" />
              <p className="text-sm text-mist">
                {progressStage === "preparing-witness"
                  ? "Preparing witness inputs…"
                  : "Generating Groth16 proof…"}
              </p>
              <p className="text-xs text-ink-500 text-center max-w-xs">
                Proof generation runs in a background worker so the UI stays responsive.
                This may take up to a minute on slower devices.
              </p>
              <div className="h-1.5 w-full max-w-xs bg-ink-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-sol-gradient rounded-full transition-all duration-700 ease-out"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <p className="text-[10px] text-ink-500">{progress}%</p>
              <button
                type="button"
                onClick={handleCancelGenerate}
                className="px-4 py-2 rounded-xl text-sm font-medium text-mist border border-ink-700 bg-ink-800 hover:bg-ink-700 transition-colors"
              >
                Cancel
              </button>
            </div>
          )}

          {step === "submitting" && (
            <div className="flex flex-col items-center gap-4 py-6">
              <span className="h-10 w-10 animate-spin rounded-full border-2 border-ink-600 border-t-white" />
              <p className="text-sm text-mist">Submitting proof on-chain…</p>
              <p className="text-xs text-ink-500 text-center max-w-xs">
                Calling verify_proof_v2 on the Groth16 Verifier program. Please confirm in your wallet.
              </p>
            </div>
          )}

          {step === "done" && proof && (
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <div className="w-5 h-5 rounded-full bg-neutral-400/20 flex items-center justify-center shrink-0">
                  <svg className="w-3 h-3 text-neutral-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                <p className="text-sm font-medium text-white">Proof ready. No private data left your browser.</p>
              </div>

              <div className="rounded-xl border border-ink-700 bg-ink-950 px-4 py-3">
                <p className="text-xs text-mist mb-2">Public signals</p>
                <div className="space-y-1">
                  {[
                    ["merkle_root", proof.publicSignals[0]],
                    ["attestation_id", proof.publicSignals[1]],
                    ["external_nullifier", proof.publicSignals[2]],
                    ["nullifier_hash", proof.publicSignals[3]],
                  ].map(([label, value]) => (
                    <div key={label} className="flex gap-2 text-xs">
                      <span className="text-mist w-36 shrink-0">{label}</span>
                      <span className="font-mono text-white truncate">{value}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={handleCopy}
                  className="flex-1 rounded-xl border border-ink-700 bg-ink-800 py-2.5 text-sm font-medium text-white hover:bg-ink-700 transition-colors"
                >
                  {copied ? "Copied!" : "Copy Proof"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const portable = createPortableProof({
                      proof: proof.proof,
                      publicSignals: proof.publicSignals,
                      circuitVersion: "v2",
                      nullifier: proof.nullifierHash,
                      schemaId: proof.schemaId,
                      externalNullifier: proof.publicSignals[2],
                    });
                    exportProofToFile(portable);
                  }}
                  className="flex-1 rounded-xl border border-ink-700 bg-ink-800 py-2.5 text-sm font-medium text-white hover:bg-ink-700 transition-colors"
                >
                  Export as File
                </button>
              </div>
              <button
                type="button"
                onClick={handleSubmitOnChain}
                disabled={!publicKey}
                className="w-full rounded-xl bg-sol-gradient text-white border border-transparent py-2.5 text-sm font-semibold hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Submit On-Chain
              </button>
              {getDemoVerifierUrl() && (
                <a
                  href={getDemoVerifierUrl()!}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block text-center text-xs text-white hover:underline"
                >
                  Open demo verifier ↗
                </a>
              )}
            </div>
          )}

          {step === "verified" && (
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <div className="w-5 h-5 rounded-full bg-neutral-400/20 flex items-center justify-center shrink-0">
                  <svg className="w-3 h-3 text-neutral-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                <p className="text-sm font-medium text-white">Proof verified on-chain!</p>
              </div>
              {txSig && (
                <a
                  href={getExplorerTxUrl(txSig)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block text-xs text-white hover:underline font-mono"
                >
                  {txSig.slice(0, 24)}… ↗
                </a>
              )}
              <button
                type="button"
                onClick={onClose}
                className="w-full rounded-xl border border-ink-700 bg-ink-800 py-2.5 text-sm font-medium text-white hover:bg-ink-700 transition-colors"
              >
                Done
              </button>
            </div>
          )}

          {step === "error" && (
            <div className="space-y-4">
              <p className="text-sm text-neutral-400">{error}</p>
              <button
                type="button"
                onClick={() => { setStep("setup"); setError(null); }}
                className="w-full rounded-xl border border-ink-700 bg-ink-800 py-2.5 text-sm font-medium text-white hover:bg-ink-700 transition-colors"
              >
                Try again
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
