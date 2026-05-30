import { useEffect, useRef, useState } from "react";
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

type Phase = "idle" | "restoring" | "connecting" | "signing" | "checking" | "register" | "registering" | "done" | "error";

export function LandingView() {
  const { setFromSignature, isSetup, stealthMetaAddressHex } = useKeys();
  const { publicKey, connected, connecting, connect, signMessage, signTransaction, wallets } = useWallet();
  const cluster = getCluster();
  const currentConfig = getConfigForCluster(cluster);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [txSig, setTxSig] = useState<string | null>(null);
  const [rememberSession, setRememberSession] = useState<boolean>(() => getRememberSignaturePreference());
  /** Set by `handleEnterVault` after `connect()`; consumed once inside the session-restore effect (same tick as reconnect, no race with signing). */
  const resumeInitializeAfterConnectRef = useRef(false);
  const rememberSessionRef = useRef(rememberSession);
  rememberSessionRef.current = rememberSession;

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

  useEffect(() => {
    if (isSetup || !connected || !address) return;

    const domainMessage = getDomainMessage(address);

    const signAndPersist = async (): Promise<`0x${string}`> => {
      if (!signMessage) throw new Error("Wallet does not support message signing.");
      setPhase("signing");
      const encoded = new TextEncoder().encode(domainMessage);
      const sigBytes = await signMessage(encoded);
      const hex = `0x${Array.from(sigBytes).map((b) => b.toString(16).padStart(2, "0")).join("")}` as `0x${string}`;
      await saveSignatureSession({
        signatureHex: hex,
        address,
        cluster,
        message: domainMessage,
        remember: rememberSessionRef.current,
      });
      return hex;
    };

    const finalizeFromSignature = async (signatureHex: `0x${string}`) => {
      setFromSignature(signatureHex);
      setPhase("checking");
      let registered: boolean;
      try {
        registered = await isRegistered(address);
      } catch {
        setError("Failed to check registration.");
        setPhase("error");
        return;
      }
      if (registered) {
        setPhase("done");
        return;
      }
      setPhase("register");
    };

    let cancelled = false;
    const run = async () => {
      setPhase("restoring");
      const saved = await loadSignatureSession({
        address,
        cluster,
        message: domainMessage,
      });
      // StrictMode: first effect run is cancelled while awaiting; unblock UI so remount can run again.
      if (cancelled) {
        setPhase("idle");
        return;
      }
      if (saved) {
        resumeInitializeAfterConnectRef.current = false;
        await finalizeFromSignature(saved);
        return;
      }
      // Migration: try loading legacy session for testnet users
      if (cluster === "testnet") {
        const legacySaved = await loadSignatureSession({
          address,
          cluster,
          message: LEGACY_SETUP_MESSAGE,
        });
        if (legacySaved) {
          resumeInitializeAfterConnectRef.current = false;
          // Re-sign with domain-separated message to migrate
          try {
            const hex = await signAndPersist();
            if (cancelled) {
              setPhase("idle");
              return;
            }
            await finalizeFromSignature(hex);
          } catch (e) {
            setError(e instanceof Error ? e.message : "Signature failed");
            setPhase("error");
          }
          return;
        }
      }
      const autoContinue = resumeInitializeAfterConnectRef.current;
      if (autoContinue) {
        resumeInitializeAfterConnectRef.current = false;
        setError(null);
        setTxSig(null);
        try {
          const hex = await signAndPersist();
          if (cancelled) {
            setPhase("idle");
            return;
          }
          await finalizeFromSignature(hex);
        } catch (e) {
          setError(e instanceof Error ? e.message : "Signature failed");
          setPhase("error");
        }
        return;
      }
      setPhase("idle");
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [isSetup, connected, address, cluster, setFromSignature, signMessage, getDomainMessage]);

  const handleEnterVault = async () => {
    setError(null);
    setTxSig(null);

    if (!connected || !address) {
      setPhase("connecting");
      try {
        if (wallets.length === 0) {
          setError("Install Freighter to connect.");
          setPhase("error");
          return;
        }
        await connect();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to connect");
        setPhase("error");
        return;
      }
      resumeInitializeAfterConnectRef.current = true;
      setPhase("idle");
      return;
    }

    const domainMessage = getDomainMessage(address);
    let signatureHex: `0x${string}` | null = null;
    signatureHex = await loadSignatureSession({
      address,
      cluster,
      message: domainMessage,
    });

    if (!signatureHex && cluster === "testnet") {
      signatureHex = await loadSignatureSession({
        address,
        cluster,
        message: LEGACY_SETUP_MESSAGE,
      });
    }

    if (!signatureHex) {
      setPhase("signing");
      try {
        if (!signMessage) throw new Error("Wallet does not support message signing.");
        const encoded = new TextEncoder().encode(domainMessage);
        const sigBytes = await signMessage(encoded);
        const hex = `0x${Array.from(sigBytes).map((b) => b.toString(16).padStart(2, "0")).join("")}` as `0x${string}`;
        signatureHex = hex;
        await saveSignatureSession({
          signatureHex: hex,
          address,
          cluster,
          message: domainMessage,
          remember: rememberSession,
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : "Signature failed");
        setPhase("error");
        return;
      }
    }
    setFromSignature(signatureHex);

    setPhase("checking");
    let registered: boolean;
    try {
      registered = await isRegistered(address);
    } catch {
      setError("Failed to check registration.");
      setPhase("error");
      return;
    }

    if (registered) {
      setPhase("done");
      return;
    }

    setPhase("register");
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
    phase === "restoring" ||
    phase === "connecting" ||
    phase === "signing" ||
    phase === "checking" ||
    phase === "registering";

  return (
    <div className="flex flex-1 flex-col items-center justify-center px-5 sm:px-8 py-16">
      <div className="w-full max-w-md text-center">
        <h1 className="font-display text-5xl font-extrabold tracking-tight text-white sm:text-6xl">
          Opaque<span className="text-sol-gradient">.</span>
        </h1>

        <p className="mt-4 text-mist">
          Connect Freighter and derive stealth keys to begin. Keys are generated on-device and never leave
          your browser.
        </p>

        {phase === "idle" && (
          <>
            <button
              type="button"
              onClick={handleEnterVault}
              disabled={connecting}
              className="mt-8 w-full rounded-xl bg-sol-gradient px-6 py-3.5 text-sm font-semibold text-white transition-all hover:shadow-[0_0_32px_rgba(153,69,255,0.3)] hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50"
            >
              {!connected ? "Connect wallet & initialize" : "Initialize protocol"}
            </button>
            <label className="mt-3 inline-flex items-center gap-2 text-xs text-mist cursor-pointer select-none">
              <input
                type="checkbox"
                checked={rememberSession}
                onChange={(e) => setRememberSession(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-ink-600 bg-ink-900 accent-sol-purple"
              />
              Remember signature for this tab (about 30 minutes)
            </label>
            <p className="mt-2 text-xs text-mist/70">
              Session cache is not a backup.{" "}
              <RecoveryDocLink section="browser-session" className="text-mist/90 hover:text-sol-purple hover:underline font-medium">
                How key recovery works
              </RecoveryDocLink>
            </p>
          </>
        )}

        {showSpinner && (
          <div className="mt-8 flex flex-col items-center gap-3">
            <span className="h-6 w-6 animate-spin rounded-full border-2 border-ink-600 border-t-sol-purple" />
            <p className="text-sm text-mist">
              {phase === "connecting" && "Check your wallet to connect…"}
              {phase === "restoring" && "Restoring your saved session…"}
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
              onClick={handleRegister}
              disabled={!currentConfig}
              className="mt-4 w-full rounded-xl bg-sol-gradient px-6 py-3 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Register
            </button>
          </div>
        )}

        {phase === "done" && (
          <p className="mt-8 text-sm text-sol-purple">Setup complete — entering dashboard…</p>
        )}

        {phase === "error" && error && (
          <div className="mt-6 rounded-xl border border-red-500/30 bg-red-950/20 px-4 py-3 text-left text-sm text-red-200">
            {error}
          </div>
        )}

        {txSig && (
          <p className="mt-4 font-mono text-xs text-mist/60 break-all">{txSig}</p>
        )}
      </div>
    </div>
  );
}
