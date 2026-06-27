/**
 * Onboarding wizard when the user is not registered on the current cluster.
 * Step 1: Info -> Step 2: Generate Stealth Keys (sign) -> Step 3: Register on-chain with progress.
 * On success: "Vault Unlocked" animation, then onComplete() to transition to dashboard.
 */

import { useEffect, useState } from "react";
import { useWallet } from "../hooks/useWallet";
import { motion, AnimatePresence } from "framer-motion";
import { getCluster } from "../lib/chain";
import { useKeys } from "../context/KeysContext";
import { registerStealthKeys, SCHEME_ID_SECP256K1 } from "../lib/contracts";
import { readNativeBalance } from "../lib/readNativeBalance";
import { hexToBytes, type Hex } from "../lib/stealth";
import {
  getConfigForCluster,
  getNetworkSupportMessage,
  isClusterSupported,
} from "../contracts/contract-config";
import {
  getRememberSignaturePreference,
  loadSignatureSession,
  saveSignatureSession,
  setRememberSignaturePreference,
} from "../lib/signatureSession";

const SETUP_MESSAGE =
  "Sign this message to derive your Opaque Cash stealth keys on Stellar. This is not a transaction and does not move funds.";

type Step = "info" | "generate" | "register" | "success";
type RegisterPhase = "idle" | "deriving" | "broadcasting" | "confirming";

function toErrorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  if (value == null) return "Unknown error";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function extractNestedErrorLines(error: unknown): string[] {
  const lines: string[] = [];
  if (!error || typeof error !== "object") return lines;
  const asRecord = error as Record<string, unknown>;
  const candidates = [asRecord.cause, asRecord.error, asRecord.originalError];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const c = candidate as Record<string, unknown>;
    if (Array.isArray(c.logs)) {
      lines.push(...(c.logs as unknown[]).map((entry) => toErrorMessage(entry)));
    }
    if (typeof c.message === "string") lines.push(c.message);
  }
  return lines;
}

function getFundingHint(cluster: string): string {
  if (cluster === "mainnet") {
    return "Fund it with mainnet XLM from a trusted Stellar wallet, exchange, or custody flow, then retry.";
  }
  if (cluster === "local") {
    return "Fund it with local network XLM, then retry.";
  }
  return "Fund it with test network XLM via Friendbot, then retry.";
}

export type RegistrationWizardProps = {
  onComplete: () => void;
};

export function RegistrationWizard({ onComplete }: RegistrationWizardProps) {
  const { setFromSignature, stealthMetaAddressHex } = useKeys();
  const { publicKey, signMessage, signTransaction } = useWallet();
  const cluster = getCluster();
  const currentConfig = getConfigForCluster(cluster);
  const address = publicKey;
  const [step, setStep] = useState<Step>("info");
  const [signing, setSigning] = useState(false);
  const [registerPhase, setRegisterPhase] = useState<RegisterPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [, setTxSig] = useState<string | null>(null);
  const [rememberSession, setRememberSession] = useState<boolean>(() => getRememberSignaturePreference());

  useEffect(() => {
    setRememberSignaturePreference(rememberSession);
  }, [rememberSession]);

  const wrongCluster = !isClusterSupported(cluster);

  const handleGenerateKeys = async () => {
    if (!address || !signMessage) {
      setError("No wallet found.");
      return;
    }
    setError(null);
    setSigning(true);
    try {
      let sig = await loadSignatureSession({
        address,
        cluster,
        message: SETUP_MESSAGE,
      });
      if (!sig) {
        const encoded = new TextEncoder().encode(SETUP_MESSAGE);
        const sigBytes = await signMessage(encoded);
        const hex = `0x${Array.from(sigBytes).map(b => b.toString(16).padStart(2, "0")).join("")}` as `0x${string}`;
        sig = hex;
        await saveSignatureSession({
          signatureHex: hex,
          address,
          cluster,
          message: SETUP_MESSAGE,
          remember: rememberSession,
        });
      }
      setFromSignature(sig);
      setStep("register");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Signature failed");
    } finally {
      setSigning(false);
    }
  };

  const handleRegister = async () => {
    if (!stealthMetaAddressHex || !publicKey || !currentConfig) return;
    setError(null);
    setTxSig(null);
    setRegisterPhase("deriving");
    await new Promise((r) => setTimeout(r, 400));
    setRegisterPhase("broadcasting");
    try {
      if (!signTransaction) throw new Error("Wallet cannot sign Soroban transactions.");
      const metaBytes = hexToBytes(stealthMetaAddressHex as Hex);
      let balance = 0n;
      try {
        balance = await readNativeBalance(publicKey);
      } catch {
        const msg =
          `Wallet ${publicKey.slice(0, 6)}…${publicKey.slice(-4)} is not funded on ${cluster}. ` +
          getFundingHint(cluster);
        setError(msg);
        setRegisterPhase("idle");
        return;
      }
      if (balance === 0n) {
        setError(`Wallet has 0 XLM on ${cluster}. ${getFundingHint(cluster)}`);
        setRegisterPhase("idle");
        return;
      }

      const sig = await registerStealthKeys({
        sourcePublicKey: publicKey,
        schemeId: SCHEME_ID_SECP256K1,
        stealthMetaAddress: metaBytes,
        signTransaction,
      });
      setTxSig(sig);
      setRegisterPhase("confirming");
      setRegisterPhase("idle");
      setStep("success");
      setTimeout(() => {
        onComplete();
      }, 1800);
    } catch (e) {
      const nestedLines = extractNestedErrorLines(e);
      const base = toErrorMessage(e);
      const details = nestedLines.length > 0 ? nestedLines.slice(0, 4).join(" | ") : null;
      const message = details ? `${base} — ${details}` : base;
      console.error("[RegistrationWizard] register_keys failed", {
        network: cluster,
        wallet: publicKey,
        error: e,
        parsedMessage: message,
      });
      setError(message || "Registration failed");
      setRegisterPhase("idle");
    }
  };

  const registerInProgress = registerPhase !== "idle";
  const progressSteps: { label: string; active: boolean; done: boolean }[] = [
    { label: "Deriving Keys", active: registerPhase === "deriving", done: registerPhase !== "deriving" && (registerPhase === "broadcasting" || registerPhase === "confirming" || step === "success") },
    { label: "Broadcasting Transaction", active: registerPhase === "broadcasting", done: registerPhase === "confirming" || step === "success" },
    { label: "Confirming…", active: registerPhase === "confirming", done: step === "success" },
  ];

  return (
    <div className="w-full max-w-lg mx-auto">
      <AnimatePresence mode="wait">
        {step === "success" ? (
          <motion.div
            key="success"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            className="card flex flex-col items-center justify-center py-12 px-6 text-center"
          >
            <motion.div
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ type: "spring", stiffness: 200, damping: 15 }}
              className="w-20 h-20 rounded-2xl bg-neutral-400/20 border-2 border-neutral-400/50 flex items-center justify-center mb-6"
              aria-hidden
            >
              <svg
                className="w-10 h-10 text-neutral-300"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z"
                />
              </svg>
            </motion.div>
            <h2 className="text-xl font-semibold text-white mb-1">Vault Unlocked</h2>
            <p className="text-sm text-neutral-500">Taking you to your dashboard…</p>
          </motion.div>
        ) : (
          <motion.div
            key="wizard"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="card"
          >
            <h2 className="text-lg font-semibold text-white mb-1">Registration required</h2>

            {step === "info" && (
              <div className="space-y-4">
                <p className="text-sm text-neutral-400 leading-relaxed">
                  Your wallet is not yet registered on this cluster. To receive private payments, you
                  need to generate and publish your Stealth Meta-Address. This is a one-time setup
                  per cluster.
                </p>
                <button
                  type="button"
                  onClick={() => setStep("generate")}
                  className="w-full py-3 px-4 rounded-lg text-sm font-medium btn-primary"
                >
                  Continue
                </button>
              </div>
            )}

            {step === "generate" && (
              <div className="space-y-4 mb-0">
                <p className="text-sm text-neutral-400">
                  Sign a message in your wallet to derive your spending and viewing keys. Keys are
                  generated locally and never leave your device.
                </p>
                <label className="inline-flex items-center gap-2 text-xs text-mist cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={rememberSession}
                    onChange={(e) => setRememberSession(e.target.checked)}
                    className="h-3.5 w-3.5 rounded border-ink-600 bg-ink-900 accent-white"
                  />
                  Remember signature for this tab (about 30 minutes)
                </label>
                {error && <p className="text-sm text-neutral-400">{error}</p>}
                <button
                  type="button"
                  onClick={handleGenerateKeys}
                  disabled={signing}
                  className="w-full py-3 px-4 rounded-lg text-sm font-medium bg-sol-gradient text-white hover:opacity-90 disabled:opacity-50 transition-opacity"
                >
                  {signing ? "Check your wallet…" : "Generate Stealth Keys"}
                </button>
              </div>
            )}

            {step === "register" && (
              <div className="space-y-4 mb-0">
                {wrongCluster && (
                  <div className="rounded-lg border border-neutral-500/40 bg-neutral-500/10 p-3 space-y-2">
                    <p className="text-sm text-neutral-300">
                      Registration is unavailable for the configured network. {getNetworkSupportMessage(cluster)}
                    </p>
                  </div>
                )}
                <p className="text-sm text-neutral-400">
                  Publish your Stealth Meta-Address on-chain so others can send to you by your Stellar
                  address.
                </p>
                {error && <p className="text-sm text-neutral-400">{error}</p>}
                <div className="space-y-2">
                  {progressSteps.map(({ label, active, done }) => (
                    <div
                      key={label}
                      className={`flex items-center gap-2 text-sm ${
                        active ? "text-white" : done ? "text-neutral-400/80" : "text-neutral-500"
                      }`}
                    >
                      {done ? (
                        <span className="text-neutral-400" aria-hidden>✓</span>
                      ) : active ? (
                        <span className="inline-block w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" aria-hidden />
                      ) : (
                        <span className="w-4 h-4 rounded-full border border-neutral-600" aria-hidden />
                      )}
                      {label}
                    </div>
                  ))}
                </div>
                {!registerInProgress && (
                  <button
                    type="button"
                    onClick={handleRegister}
                    disabled={!currentConfig || wrongCluster}
                    className="w-full py-3 px-4 rounded-lg text-sm font-medium btn-primary disabled:opacity-50 disabled:cursor-not-allowed mt-4"
                  >
                    Register on {cluster}
                  </button>
                )}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
