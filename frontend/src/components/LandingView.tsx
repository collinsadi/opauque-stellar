import { useCallback, useEffect, useRef, useState } from "react";
import { useWallet } from "../hooks/useWallet";
import { getCluster, getNetworkPassphrase } from "../lib/chain";
import { useKeys } from "../context/KeysContext";
import { isRegistered } from "../lib/registry";
import { registerStealthKeys, SCHEME_ID_SECP256K1 } from "../lib/contracts";
import { hexToBytes, buildDomainSeparatedMessage, LEGACY_SETUP_MESSAGE, type Hex } from "../lib/stealth";
import { getConfigForCluster } from "../contracts/contract-config";
import {
  getRememberSignaturePreference,
  loadSignatureSession,
  saveSignatureSession,
  setRememberSignaturePreference,
} from "../lib/signatureSession";
import { RecoveryDocLink } from "./RecoveryDocLink";

type Phase = "idle" | "connecting" | "signing" | "checking" | "register" | "registering" | "done" | "error";

export function LandingView() {
  const { setFromSignature, isSetup, stealthMetaAddressHex } = useKeys();
  const { publicKey, connected, connecting, connect, signMessage, signTransaction } = useWallet();
  const cluster = getCluster();
  const currentConfig = getConfigForCluster(cluster);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [txSig, setTxSig] = useState<string | null>(null);
  const [rememberSession, setRememberSession] = useState<boolean>(() => getRememberSignaturePreference());
  const flowInFlightRef = useRef(false);
  const silentRestoreAttemptedRef = useRef(false);

  const getDomainMessage = useCallback((addr: string) => {
    return buildDomainSeparatedMessage({
      origin: window.location.origin,
      networkPassphrase: getNetworkPassphrase(),
      walletPublicKey: addr,
      purpose: "stealth-key-derivation",
    });
  }, []);

  const address = publicKey;

  useEffect(() => {
    setRememberSignaturePreference(rememberSession);
  }, [rememberSession]);

  const finalizeFromSignature = useCallback(
    async (addr: string, signatureHex: `0x${string}`) => {
      setFromSignature(signatureHex);
      setPhase("checking");
      let registered: boolean;
      try {
        registered = await isRegistered(addr);
      } catch {
        setError("Failed to check registration.");
        setPhase("error");
        return;
      }
      setPhase(registered ? "done" : "register");
    },
    [setFromSignature],
  );

  const resolveSignature = useCallback(
    async (addr: string): Promise<`0x${string}` | null> => {
      const domainMessage = getDomainMessage(addr);
      let saved = await loadSignatureSession({
        address: addr,
        cluster,
        message: domainMessage,
      });
      if (!saved && cluster === "testnet") {
        saved = await loadSignatureSession({
          address: addr,
          cluster,
          message: LEGACY_SETUP_MESSAGE,
        });
      }
      if (saved) return saved;

      if (!signMessage) throw new Error("Wallet does not support message signing.");
      setPhase("signing");
      const encoded = new TextEncoder().encode(domainMessage);
      const sigBytes = await signMessage(encoded);
      const hex = `0x${Array.from(sigBytes).map((b) => b.toString(16).padStart(2, "0")).join("")}` as `0x${string}`;
      await saveSignatureSession({
        signatureHex: hex,
        address: addr,
        cluster,
        message: domainMessage,
        remember: rememberSession,
      });
      return hex;
    },
    [cluster, getDomainMessage, rememberSession, signMessage],
  );

  // Silent restore only: if Freighter is already connected and we have a cached signature, skip prompts.
  useEffect(() => {
    if (isSetup || !connected || !address || silentRestoreAttemptedRef.current) return;
    silentRestoreAttemptedRef.current = true;

    let cancelled = false;
    const run = async () => {
      const domainMessage = getDomainMessage(address);
      const saved = await loadSignatureSession({
        address,
        cluster,
        message: domainMessage,
      });
      if (cancelled || !saved) return;
      await finalizeFromSignature(address, saved);
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [isSetup, connected, address, cluster, getDomainMessage, finalizeFromSignature]);

  const handleEnterVault = async () => {
    if (flowInFlightRef.current || connecting) return;
    flowInFlightRef.current = true;
    setError(null);
    setTxSig(null);

    try {
      let activeAddress = address;
      if (!connected || !activeAddress) {
        setPhase("connecting");
        activeAddress = await connect();
      }

      const signatureHex = await resolveSignature(activeAddress);
      if (!signatureHex) {
        throw new Error("Failed to obtain setup signature.");
      }
      await finalizeFromSignature(activeAddress, signatureHex);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Setup failed");
      setPhase("error");
    } finally {
      flowInFlightRef.current = false;
    }
  };

  const handleRegister = async () => {
    if (!stealthMetaAddressHex || !publicKey || !currentConfig) return;
    setError(null);
    setTxSig(null);
    setPhase("registering");
    try {
      if (!signTransaction) throw new Error("Wallet cannot sign transactions.");
      const metaBytes = hexToBytes(stealthMetaAddressHex as Hex);
      const sig = await registerStealthKeys({
        sourcePublicKey: publicKey,
        schemeId: SCHEME_ID_SECP256K1,
        stealthMetaAddress: metaBytes,
        signTransaction,
      });
      setTxSig(sig);
      setPhase("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Registration failed");
      setPhase("register");
    }
  };

  if (isSetup) return null;

  const showSpinner =
    phase === "connecting" ||
    phase === "signing" ||
    phase === "checking" ||
    phase === "registering";

  return (
    <div className="flex flex-1 flex-col items-center justify-center px-5 sm:px-8 py-16">
      <div className="w-full max-w-md text-center">
        <h1 className="font-display text-5xl font-extrabold tracking-tight text-white sm:text-6xl">
          Opaque<span className="text-white">.</span>
        </h1>

        <p className="mt-4 text-mist">
          Connect Freighter and derive stealth keys to begin. Keys are generated on-device and never leave
          your browser.
        </p>

        {phase === "idle" && (
          <>
            <button
              type="button"
              onClick={() => void handleEnterVault()}
              disabled={connecting || flowInFlightRef.current}
              className="mt-8 w-full rounded-xl bg-sol-gradient border border-transparent px-6 py-3.5 text-sm font-semibold text-white transition-all hover:opacity-90 hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50"
            >
              {!connected ? "Connect wallet & initialize" : "Initialize protocol"}
            </button>
            <label className="mt-3 inline-flex items-center gap-2 text-xs text-mist cursor-pointer select-none">
              <input
                type="checkbox"
                checked={rememberSession}
                onChange={(e) => setRememberSession(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-ink-600 bg-ink-900 accent-white"
              />
              Remember signature for this tab (about 30 minutes)
            </label>
            <p className="mt-2 text-xs text-mist/70">
              Session cache is not a backup.{" "}
              <RecoveryDocLink section="browser-session" className="text-mist/90 hover:text-white hover:underline font-medium">
                How key recovery works
              </RecoveryDocLink>
            </p>
          </>
        )}

        {showSpinner && (
          <div className="mt-8 flex flex-col items-center gap-3">
            <span className="h-6 w-6 animate-spin rounded-full border-2 border-ink-600 border-t-white" />
            <p className="text-sm text-mist">
              {phase === "connecting" && "Check your wallet to connect…"}
              {phase === "signing" && "Sign the message in your wallet…"}
              {phase === "checking" && "Checking registry…"}
              {phase === "registering" && "Confirm the transaction…"}
            </p>
          </div>
        )}

        {phase === "register" && (
          <div className="mt-8 rounded-2xl border border-ink-700 bg-ink-900/40 p-6 text-left">
            <h2 className="font-display text-lg font-bold text-white">
              Register on Stellar
            </h2>
            <p className="mt-2 text-sm text-mist">
              One-time transaction on the registry program so payers can resolve your stealth meta-address from your wallet.
            </p>
            {error && <p className="mt-3 text-sm text-error">{error}</p>}
            <button
              type="button"
              onClick={() => void handleRegister()}
              disabled={!currentConfig}
              className="mt-4 w-full rounded-xl bg-sol-gradient border border-transparent px-6 py-3 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Register
            </button>
          </div>
        )}

        {phase === "done" && (
          <p className="mt-8 text-sm text-white">Setup complete — entering dashboard…</p>
        )}

        {phase === "error" && error && (
          <div className="mt-6 space-y-4">
            <div className="rounded-xl border border-neutral-500/30 bg-neutral-950/20 px-4 py-3 text-left text-sm text-neutral-300">
              {error}
            </div>
            <button
              type="button"
              onClick={() => {
                setPhase("idle");
                setError(null);
              }}
              className="w-full rounded-xl border border-ink-600 px-6 py-3 text-sm font-medium text-mist hover:text-white"
            >
              Try again
            </button>
          </div>
        )}

        {txSig && (
          <p className="mt-4 font-mono text-xs text-mist/60 break-all">{txSig}</p>
        )}
      </div>
    </div>
  );
}
