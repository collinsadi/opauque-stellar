/**
 * Proof Generator Modal — V2
 *
 * Generates a Groth16 ZK proof for a discovered V2 trait, entirely in the browser.
 * No private data leaves the user's device. The proof can then be submitted on-chain
 * to the groth16_verifier program's verify_proof_v2 instruction.
 */

import { useState } from "react";
import type { V2DiscoveredTrait } from "../store/schemaStore";
import { useWallet } from "../hooks/useWallet";
import { invokeVerifyProofV2, hexToBytes, hexPubkeyToBase58 } from "../lib/programs";
import { useOpaqueWasm } from "../hooks/useOpaqueWasm";
import { useKeys } from "../context/KeysContext";
import { getAnnouncementsForCluster } from "../lib/opaqueCache";
import { getCluster } from "../lib/chain";
import { fetchLatestValidMerkleRoot, generateReputationProof } from "../lib/reputationProver";
import { getExplorerTxUrl } from "../lib/explorer";

// @ts-expect-error snarkjs has no bundled types
import * as snarkjs from "snarkjs";


import { buildPoseidon } from "circomlibjs";

// =============================================================================
// Constants
// =============================================================================

const V2_CIRCUIT_WASM_PATH = "/circuits/v2/stealth_reputation.wasm";
const V2_ZKEY_PATH = "/circuits/v2/stealth_reputation_final.zkey";
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
 *  - Merkle tree: single-leaf Poseidon tree at depth 20 (leaf = the user's attestation)
 *  - trait_data_hash: 0n (data_hex is not decoded in this release; proof is still sound)
 *  - nullifier_hash: Poseidon2(stealth_pk, external_nullifier) in JS
 */
async function buildCircuitInputs(
  trait: V2DiscoveredTrait,
  externalNullifierStr: string,
  wasm: {
    reconstruct_signing_key_wasm: (a: Uint8Array, b: Uint8Array, c: Uint8Array) => Uint8Array;
  },
  masterKeys: { viewPrivKey: Uint8Array; spendPrivKey: Uint8Array },
  ephemeralPubKeyBytes: Uint8Array
): Promise<Record<string, unknown>> {
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
  // trait_data_hash is a placeholder (0) until data decoding is implemented.
  const traitDataHash = 0n;

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

  // ── 6. Build a depth-20 single-leaf Poseidon Merkle tree ─────────────────
  // zero_hashes[i] = hash of an empty subtree at level i.
  const zeroHashes: bigint[] = [0n];
  for (let i = 0; i < MERKLE_DEPTH; i++) {
    zeroHashes.push(ph([zeroHashes[i], zeroHashes[i]]));
  }

  // The single leaf is at index 0 (always a left child at every level).
  const merklePath: bigint[] = [];
  const merklePathIndices: number[] = [];
  let current: bigint = leaf;
  for (let i = 0; i < MERKLE_DEPTH; i++) {
    merklePath.push(zeroHashes[i]);   // sibling = empty subtree at this level
    merklePathIndices.push(0);        // 0 = current node is the left child
    current = ph([current, zeroHashes[i]]);
  }
  const merkleRoot: bigint = current;

  // ── 7. Compute nullifier_hash = Poseidon2(stealth_pk, external_nullifier) ─
  const nullifierHash: bigint = ph([stealthPk, externalNullifier]);

  // ── 8. Assemble all 49 circuit signals ───────────────────────────────────
  return {
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
  const [step, setStep] = useState<ProofStep>("setup");
  const [externalNullifier, setExternalNullifier] = useState("");
  const [proof, setProof] = useState<GeneratedProof | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [txSig, setTxSig] = useState<string | null>(null);

  const handleGenerate = async () => {
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

      // Reconstruct stealth private key bytes for proof generation
      const stealthPrivKeyBytes = wasm.reconstruct_signing_key_wasm(
        masterKeys.spendPrivKey,
        masterKeys.viewPrivKey,
        ephemeralPubKeyBytes
      );

      // Use unified helper to generate proof and public signals
      const proofData = await generateReputationProof(
        wasm,
        trait,
        "",
        stealthPrivKeyBytes,
        externalNullifier,
        (stage, percent) => {
          // Optional: map progress stages to UI steps if needed
        }
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
      if (
        msg.includes("fetch") ||
        msg.includes("404") ||
        msg.includes("NetworkError") ||
        msg.includes("Failed to load")
      ) {
        setError(
          "V2 circuit files not found. Run the V2 trusted setup and copy the WASM + zkey to frontend/public/circuits/v2/. " +
            "See next_steps.md Phase 1 for instructions."
        );
      } else {
        setError(msg);
      }
      setStep("error");
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
        setError("Merkle root mismatch: proof does not correspond to current on-chain root.");
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
              <div className="space-y-2">
                <label className="block text-sm font-medium text-white">
                  External Nullifier
                </label>
                <input
                  type="text"
                  placeholder="Decimal or 0x-hex domain separator from the requesting dApp"
                  value={externalNullifier}
                  onChange={(e) => setExternalNullifier(e.target.value)}
                  className="w-full rounded-xl border border-ink-700 bg-ink-950 px-4 py-3 text-white placeholder-ink-500 focus:outline-none focus:border-sol-purple text-sm font-mono"
                />
                <p className="text-xs text-mist">
                  Must be a decimal number or 0x-prefixed hex (e.g. <span className="font-mono text-ink-400">1</span> or <span className="font-mono text-ink-400">0x01</span>).
                  Prevents replay across different applications.
                </p>
              </div>

              {error && (
                <p className="text-sm text-red-400">{error}</p>
              )}

              <button
                type="button"
                onClick={handleGenerate}
                disabled={!externalNullifier.trim()}
                className="w-full rounded-xl bg-sol-purple py-3 text-sm font-semibold text-white hover:bg-sol-purple/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Generate Proof in Browser
              </button>

              <p className="text-center text-xs text-ink-500">
                No private data leaves your browser. Proof generation takes 10–60 seconds.
              </p>
            </>
          )}

          {step === "generating" && (
            <div className="flex flex-col items-center gap-4 py-6">
              <span className="h-10 w-10 animate-spin rounded-full border-2 border-ink-600 border-t-sol-purple" />
              <p className="text-sm text-mist">Generating ZK proof locally…</p>
              <p className="text-xs text-ink-500 text-center max-w-xs">
                The Groth16 prover runs entirely in your browser. This may take up to a minute on slower devices.
              </p>
            </div>
          )}

          {step === "submitting" && (
            <div className="flex flex-col items-center gap-4 py-6">
              <span className="h-10 w-10 animate-spin rounded-full border-2 border-ink-600 border-t-sol-purple" />
              <p className="text-sm text-mist">Submitting proof on-chain…</p>
              <p className="text-xs text-ink-500 text-center max-w-xs">
                Calling verify_proof_v2 on the Groth16 Verifier program. Please confirm in your wallet.
              </p>
            </div>
          )}

          {step === "done" && proof && (
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <div className="w-5 h-5 rounded-full bg-green-500/20 flex items-center justify-center shrink-0">
                  <svg className="w-3 h-3 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
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
                  onClick={handleSubmitOnChain}
                  disabled={!publicKey}
                  className="flex-1 rounded-xl bg-sol-purple py-2.5 text-sm font-semibold text-white hover:bg-sol-purple/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  Submit On-Chain
                </button>
              </div>
            </div>
          )}

          {step === "verified" && (
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <div className="w-5 h-5 rounded-full bg-green-500/20 flex items-center justify-center shrink-0">
                  <svg className="w-3 h-3 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
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
                  className="block text-xs text-sol-purple hover:underline font-mono"
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
              <p className="text-sm text-red-400">{error}</p>
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
