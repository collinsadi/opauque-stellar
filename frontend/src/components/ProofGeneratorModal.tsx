/**
 * Proof Generator Modal - V2
 *
 * Generates a Groth16 ZK proof for a discovered V2 trait, entirely in the browser.
 * No private data leaves the user's device. The proof can then be submitted on-chain
 * to the groth16_verifier program's verify_proof_v2 instruction.
 */

import { useState } from "react";
import type { V2DiscoveredTrait } from "../store/schemaStore";
import { useWallet } from "../hooks/useWallet";
import { hexToBytes, hexPubkeyToBase58 } from "../lib/programs";
import { useOpaqueWasm } from "../hooks/useOpaqueWasm";
import { useKeys } from "../context/KeysContext";
import { useFreezeStatus } from "../hooks/useFreezeStatus";
import { getAnnouncementsForCluster } from "../lib/opaqueCache";
import { getCluster } from "../lib/chain";
import { submitProofOnChain } from "../lib/reputationProver";
import {
  submitLeafAndFetchInclusion,
  type ReputationPublisherInclusion,
} from "../lib/reputationPublisher";
import type { ProofData } from "../lib/reputation";
import { getExplorerTxUrl } from "../lib/explorer";
import { getDemoVerifierUrl } from "../lib/featureFlags";
import { isWasmHtmlFallbackError, publicAssetPath } from "../lib/publicAssets";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { CopyStatusHint } from "./CopyStatusHint";
import { ModalShell } from "./ModalShell";

// @ts-expect-error snarkjs has no bundled types
import * as snarkjs from "snarkjs";


import { buildPoseidon } from "circomlibjs";

// =============================================================================
// Constants
// =============================================================================

const V2_CIRCUIT_WASM_PATH = publicAssetPath("circuits/v2/stealth_reputation.wasm");
const V2_ZKEY_PATH = publicAssetPath("circuits/v2/stealth_reputation_final.zkey");
const MERKLE_DEPTH = 20;

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

function stringToBigInt(s: string): bigint {
  if (s.startsWith("0x") || s.startsWith("0X")) return BigInt(s);
  return BigInt(s);
}

function bigintToHex32(n: bigint): string {
  return `0x${n.toString(16).padStart(64, "0")}`;
}

/** Convert 32 raw bytes (big-endian) to a BigInt field element. */
function bytesToFieldBigInt(bytes: Uint8Array): bigint {
  let val = 0n;
  for (const b of bytes) {
    val = (val << 8n) | BigInt(b);
  }
  return val;
}

/**
 * Build all 49 circuit inputs for the StealthReputation(20) circuit.
 *
 * Circuit private inputs:  stealth_pk, schema_id, issuer_pk_x, trait_data_hash,
 *                          nonce, merkle_path[20], merkle_path_indices[20]
 * Circuit public inputs:   merkle_root, attestation_id, external_nullifier, nullifier_hash
 *
 * Strategy:
 *  - stealth_pk: reconstructed from master spend/view keys + ephemeral pubkey (via WASM)
 *  - Merkle path/root: fetched from the reputation publisher after submitting the leaf commitment
 *  - nullifier_hash: Poseidon2(stealth_pk, external_nullifier) in JS
 */
async function buildCircuitInputs(
  trait: V2DiscoveredTrait,
  externalNullifierStr: string,
  wasm: {
    reconstruct_signing_key_wasm: (a: Uint8Array, b: Uint8Array, c: Uint8Array) => Uint8Array;
  },
  masterKeys: { viewPrivKey: Uint8Array; spendPrivKey: Uint8Array },
  ephemeralPubKeyBytes: Uint8Array,
  publishedPath?: ReputationPublisherInclusion,
): Promise<{ inputs: Record<string, unknown>; leafHex: string; rootHex: string }> {
  // ── 1. Reconstruct the stealth secp256k1 private key ─────────────────────
  const stealthPrivKeyBytes = wasm.reconstruct_signing_key_wasm(
    masterKeys.spendPrivKey,
    masterKeys.viewPrivKey,
    ephemeralPubKeyBytes
  );
  const stealthPk = bytesToFieldBigInt(stealthPrivKeyBytes);

  // ── 2. Parse preimage field elements ─────────────────────────────────────
  // WASM scanner stores these as 0x-prefixed 64-char hex strings.
  const schemaId = stringToBigInt(trait.merkleLeafPreimage.schemaIdField);
  const issuerPkX = stringToBigInt(trait.merkleLeafPreimage.issuerPkX);
  const nonce = stringToBigInt(trait.merkleLeafPreimage.nonceField);
  const traitDataHash = stringToBigInt(trait.merkleLeafPreimage.traitDataHash);

  // ── 3. Parse external nullifier (decimal or 0x-hex) ──────────────────────
  const externalNullifier = stringToBigInt(externalNullifierStr.trim());

  // ── 4. Build Poseidon (circomlib-compatible) ──────────────────────────────
  // NOTE: circomlibjs poseidon returns a Uint8Array (field element), NOT a
  // bigint. Always convert with poseidon.F.toObject() before arithmetic.
  const poseidon = await buildPoseidon();
  const F = poseidon.F;
  /** Wrap poseidon call so callers always get a proper bigint back. */
  const ph = (inputs: bigint[]): bigint => F.toObject(poseidon(inputs)) as bigint;

  // ── 5. Compute the leaf: Poseidon5(stealth_pk, schema_id, issuer_pk_x, trait_data_hash, nonce)
  const leaf: bigint = ph([stealthPk, schemaId, issuerPkX, traitDataHash, nonce]);

  // ── 6. Use the published Merkle path when available. The no-path branch is only
  // used to compute the leaf commitment before the publisher has returned inclusion.
  let merklePath: bigint[] = [];
  let merklePathIndices: number[] = [];
  let merkleRoot: bigint;
  if (publishedPath) {
    if (publishedPath.leaf.toLowerCase() !== bigintToHex32(leaf).toLowerCase()) {
      throw new Error("Publisher returned an inclusion path for a different reputation leaf.");
    }
    if (publishedPath.pathElements.length !== MERKLE_DEPTH || publishedPath.pathIndices.length !== MERKLE_DEPTH) {
      throw new Error("Publisher returned an invalid Merkle path length.");
    }
    merklePath = publishedPath.pathElements.map(stringToBigInt);
    merklePathIndices = publishedPath.pathIndices;
    merkleRoot = stringToBigInt(publishedPath.root);
  } else {
    const zeroHashes: bigint[] = [0n];
    for (let i = 0; i < MERKLE_DEPTH; i++) {
      zeroHashes.push(ph([zeroHashes[i], zeroHashes[i]]));
    }
    let current: bigint = leaf;
    for (let i = 0; i < MERKLE_DEPTH; i++) {
      merklePath.push(zeroHashes[i]);
      merklePathIndices.push(0);
      current = ph([current, zeroHashes[i]]);
    }
    merkleRoot = current;
  }

  // ── 7. Compute nullifier_hash = Poseidon2(stealth_pk, external_nullifier) ─
  const nullifierHash: bigint = ph([stealthPk, externalNullifier]);

  // ── 8. Assemble all 49 circuit signals ───────────────────────────────────
  return {
    leafHex: bigintToHex32(leaf),
    rootHex: bigintToHex32(merkleRoot),
    inputs: {
      // Private
      stealth_pk: stealthPk.toString(),
      schema_id: schemaId.toString(),
      issuer_pk_x: issuerPkX.toString(),
      trait_data_hash: traitDataHash.toString(),
      nonce: nonce.toString(),
      merkle_path: merklePath.map((h) => h.toString()),
      merkle_path_indices: merklePathIndices,
      // Public
      merkle_root: merkleRoot.toString(),
      attestation_id: schemaId.toString(),
      external_nullifier: externalNullifier.toString(),
      nullifier_hash: nullifierHash.toString(),
    },
  };
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
  const freeze = useFreezeStatus(publicKey);
  const [step, setStep] = useState<ProofStep>("setup");
  const [externalNullifier, setExternalNullifier] = useState("");
  const [proof, setProof] = useState<GeneratedProof | null>(null);
  const [error, setError] = useState<string | null>(null);
  const proofCopy = useCopyToClipboard({ secret: true });
  const [txSig, setTxSig] = useState<string | null>(null);

  const handleGenerate = async () => {
    if (freeze.frozen) {
      setError(
        freeze.message ??
          "Proof generation is blocked: the reputation root is frozen.",
      );
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

      // Compute the V2 leaf commitment locally, submit it to the root publisher,
      // then build the proof witness against the publisher's on-chain root/path.
      const draft = await buildCircuitInputs(
        trait,
        externalNullifier,
        wasm,
        masterKeys,
        ephemeralPubKeyBytes
      );
      const inclusion = await submitLeafAndFetchInclusion({
        id: trait.attestationUid || draft.leafHex,
        leaf: draft.leafHex,
        schemaId: bigintToHex32(stringToBigInt(trait.merkleLeafPreimage.schemaIdField)),
        attestationUid: trait.attestationUid,
        txHash: trait.txHash,
        ledger: trait.slot,
      });
      const { inputs: circuitInputs } = await buildCircuitInputs(
        trait,
        externalNullifier,
        wasm,
        masterKeys,
        ephemeralPubKeyBytes,
        inclusion,
      );

      // Generate the Groth16 proof against the V2 circuit artifacts.
      const { proof: snarkProof, publicSignals } = await snarkjs.groth16.fullProve(
        circuitInputs,
        V2_CIRCUIT_WASM_PATH,
        V2_ZKEY_PATH
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
      setStep("done");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (isWasmHtmlFallbackError(msg)) {
        setError(
          `The deployed app is serving HTML instead of the V2 witness WASM at ${V2_CIRCUIT_WASM_PATH}. ` +
            "Redeploy with the frontend circuit artifacts present and hash-verified. " +
            "See docs/TROUBLESHOOTING_PROOF_GENERATION.md."
        );
      } else if (
        msg.includes("fetch") ||
        msg.includes("404") ||
        msg.includes("NetworkError") ||
        msg.includes("Failed to load")
      ) {
        setError(
          `V2 circuit files were not found at ${V2_CIRCUIT_WASM_PATH} and ${V2_ZKEY_PATH}. ` +
            "Redeploy with the frontend circuit artifacts present and hash-verified. " +
            "See docs/TROUBLESHOOTING_PROOF_GENERATION.md."
        );
      } else {
        setError(msg);
      }
      setStep("error");
    }
  };

  const handleCopy = async () => {
    if (!proof) return;
    await proofCopy.copy(JSON.stringify(proof, null, 2));
  };

  const handleSubmitOnChain = async () => {
    if (!proof || !publicKey) {
      setError("Connect wallet to submit proof on-chain.");
      return;
    }
    setStep("submitting");
    setError(null);

    try {
      if (!signTransaction) {
        throw new Error("Connect wallet to submit proof on-chain.");
      }

      const proofData: ProofData = {
        proof: proof.proof,
        publicSignals: proof.publicSignals,
        nullifier: proof.nullifierHash,
        attestationId: stringToBigInt(proof.publicSignals[1]),
      };

      const signature = await submitProofOnChain(
        proofData,
        proof.publicSignals[0],
        proof.publicSignals[2],
        signTransaction,
        publicKey,
      );

      setTxSig(signature);
      setStep("verified");
    } catch (e) {
      const details = e instanceof Error ? e.message : "On-chain verification failed";
      setError(`Soroban proof verification failed: ${details}`);
      setStep("error");
    }
  };

  const issuerBase58 = hexPubkeyToBase58(trait.issuer);
  const issuerShort = `${issuerBase58.slice(0, 6)}…${issuerBase58.slice(-4)}`;

  return (
    <ModalShell
      open
      title="Generate ZK Proof"
      onClose={onClose}
      maxWidthClassName="max-w-lg"
    >
      <div className="space-y-5">
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
              {freeze.frozen && (
                <div className="p-3 rounded-xl bg-error/10 border border-error/30 text-error text-sm">
                  {freeze.message ??
                    "Proof generation is blocked: the reputation root is frozen."}
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
                disabled={!externalNullifier.trim() || freeze.frozen}
                className="w-full rounded-xl bg-white text-black border border-white py-3 text-sm font-semibold hover:bg-black hover:text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {freeze.frozen ? "Proof generation blocked" : "Generate Proof in Browser"}
              </button>

              <p className="text-center text-xs text-ink-500">
                No private data leaves your browser. Proof generation takes 10-60 seconds.
              </p>
            </>
          )}

          {step === "generating" && (
            <div className="flex flex-col items-center gap-4 py-6">
              <span className="h-10 w-10 animate-spin rounded-full border-2 border-ink-600 border-t-white" />
              <p className="text-sm text-mist">Generating ZK proof locally…</p>
              <p className="text-xs text-ink-500 text-center max-w-xs">
                The Groth16 prover runs entirely in your browser. This may take up to a minute on slower devices.
              </p>
            </div>
          )}

          {step === "submitting" && (
            <div className="flex flex-col items-center gap-4 py-6">
              <span className="h-10 w-10 animate-spin rounded-full border-2 border-ink-600 border-t-white" />
              <p className="text-sm text-mist">Submitting proof on-chain…</p>
              <p className="text-xs text-ink-500 text-center max-w-xs">
                Calling verify_reputation on the Reputation Verifier program. Please confirm in your wallet.
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

              <div>
                <div className="flex gap-3">
                  <button
                    type="button"
                    onClick={handleCopy}
                    className="flex-1 rounded-xl border border-ink-700 bg-ink-800 py-2.5 text-sm font-medium text-white hover:bg-ink-700 transition-colors"
                  >
                    {proofCopy.status === "copied" ? "Copied!" : "Copy Proof"}
                  </button>
                  <button
                    type="button"
                    onClick={handleSubmitOnChain}
                    disabled={!publicKey}
                  className="flex-1 rounded-xl bg-white text-black border border-white py-2.5 text-sm font-semibold hover:bg-black hover:text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  Submit On-Chain
                </button>
                </div>
                <CopyStatusHint
                  status={proofCopy.status}
                  remaining={proofCopy.remaining}
                  onCancelClear={proofCopy.cancelClear}
                />
              </div>
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
    </ModalShell>
  );
}
