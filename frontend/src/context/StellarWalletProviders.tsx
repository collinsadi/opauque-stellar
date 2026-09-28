import { createContext, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  getAddress,
  isAllowed,
  isConnected as freighterIsConnected,
  requestAccess,
  signMessage as freighterSignMessage,
  signTransaction,
} from "@stellar/freighter-api";
import { getNetworkPassphrase } from "../lib/chain";
import type { SignTxFn } from "../lib/stellar";
import { logSigningEvent } from "../lib/signingAuditLog";
import {
  classifyWalletError,
  type WalletConnectionErrorDetails,
} from "../lib/walletErrors";

export type StellarWalletContextValue = {
  publicKey: string | null;
  connected: boolean;
  connecting: boolean;
  connect: () => Promise<string>;
  disconnect: () => void;
  signTransaction: SignTxFn;
  signMessage: ((message: Uint8Array) => Promise<Uint8Array>) | null;
  connectionError: WalletConnectionErrorDetails | null;
};

export const StellarWalletContext = createContext<StellarWalletContextValue | null>(null);

/**
 * E2E test harness (Playwright): the real Freighter extension isn't installed
 * in a headless browser, and its API talks to a background extension context
 * that doesn't exist in CI. Tests inject this global via `page.addInitScript`
 * *before* the app loads (see `frontend/e2e/fixtures/wallet.ts`) to stand in
 * for the extension without touching production code paths —
 * `window.__OPAQUE_E2E_WALLET__` is never set outside of test runs.
 */
declare global {
  interface Window {
    __OPAQUE_E2E_WALLET__?: {
      publicKey: string;
      signTransaction?: (xdr: string) => Promise<string> | string;
      signMessage?: (message: Uint8Array) => Promise<Uint8Array> | Uint8Array;
    };
  }
}

function getE2EWallet() {
  return typeof window !== "undefined" ? window.__OPAQUE_E2E_WALLET__ : undefined;
}

export function StellarWalletProviders({ children }: { children: ReactNode }) {
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connectionError, setConnectionError] = useState<WalletConnectionErrorDetails | null>(null);
  const connectInFlightRef = useRef(false);

  // Restore an already-authorized Freighter session without prompting. Polling
  // detects account changes made in the extension while the app remains open.
  useEffect(() => {
    let active = true;
    const syncAddress = async () => {
      try {
        const address = await tryRestoreFreighterSession();
        if (!active) return;
        if (address) {
          setPublicKey((current) => current === address ? current : address);
          setConnected(true);
        } else if (connected) {
          setPublicKey(null);
          setConnected(false);
        }
      } catch {
        // Keep the current session on transient extension errors.
      }
    };
    void syncAddress();
    const timer = window.setInterval(() => void syncAddress(), 1500);
    return () => { active = false; window.clearInterval(timer); };
  }, [connected]);

  const connect = useCallback(async (): Promise<string> => {
    setConnectionError(null);
    const e2e = getE2EWallet();
    if (e2e) {
      setPublicKey(e2e.publicKey);
      setConnected(true);
      return e2e.publicKey;
    }
    if (connectInFlightRef.current) {
      const { address } = await getAddress();
      return address;
    }
    connectInFlightRef.current = true;
    setConnecting(true);
    try {
      const installed = await freighterIsConnected();
      if (!installed.isConnected) {
        const error = classifyWalletError("Freighter extension is not installed");
        setConnectionError(error);
        throw new Error(error.message);
      }

      const allowed = await isAllowed();
      if (!allowed.isAllowed) {
        const access = await requestAccess();
        if (access.error) {
          const classified = classifyWalletError(access.error);
          setConnectionError(classified);
          throw new Error(classified.message);
        }
        if (access.address) {
          setPublicKey(access.address);
          setConnected(true);
          return access.address;
        }
      }
      const { address, error } = await getAddress();
      if (error) {
        const classified = classifyWalletError(error);
        setConnectionError(classified);
        throw new Error(classified.message);
      }
      if (!address) {
        const error = classifyWalletError("locked");
        setConnectionError(error);
        throw new Error(error.message);
      }
      setPublicKey(address);
      setConnected(true);
      return address;
    } catch (err) {
      if (!connectionError && err instanceof Error) {
        const classified = classifyWalletError(err);
        setConnectionError(classified);
      }
      throw err;
    } finally {
      setConnecting(false);
      connectInFlightRef.current = false;
    }
  }, [connectionError]);

  const disconnect = useCallback(() => {
    setPublicKey(null);
    setConnected(false);
    setConnectionError(null);
  }, []);

  const signTx: SignTxFn = useCallback(
    async (xdr: string) => {
      const e2e = getE2EWallet();
      if (e2e?.signTransaction) return e2e.signTransaction(xdr);
      const res = await signTransaction(xdr, {
        networkPassphrase: getNetworkPassphrase(),
        address: publicKey ?? undefined,
      });
      if (res.error) throw new Error(freighterErrorMessage(res.error, "Failed to sign the transaction."));
      logSigningEvent("transaction");
      return res.signedTxXdr;
    },
    [publicKey],
  );

  const signMessage = useCallback(
    async (message: Uint8Array): Promise<Uint8Array> => {
      const e2e = getE2EWallet();
      if (e2e?.signMessage) return e2e.signMessage(message);
      // The setup message is UTF-8 text; Freighter's signMessage takes a string.
      const text = new TextDecoder().decode(message);
      const res = await freighterSignMessage(text, { address: publicKey ?? undefined });
      if (res.error) throw new Error(freighterErrorMessage(res.error, "Failed to sign the setup message."));
      const signed = res.signedMessage;
      if (signed == null) throw new Error("Freighter returned no signature.");
      logSigningEvent("message");
      // Freighter returns a Buffer (v3) or a base64 string (v4) depending on version.
      return typeof signed === "string"
        ? Uint8Array.from(Buffer.from(signed, "base64"))
        : Uint8Array.from(signed);
    },
    [publicKey],
  );

  const value = useMemo(
    () => ({
      publicKey,
      connected,
      connecting,
      connect,
      disconnect,
      signTransaction: signTx,
      signMessage,
      connectionError,
    }),
    [publicKey, connected, connecting, connect, disconnect, signTx, signMessage, connectionError],
  );

  return <StellarWalletContext.Provider value={value}>{children}</StellarWalletContext.Provider>;
}

export async function tryRestoreFreighterSession(): Promise<string | null> {
  const e2e = getE2EWallet();
  if (e2e) return e2e.publicKey;
  const installed = await freighterIsConnected();
  if (!installed.isConnected) return null;
  const allowed = await isAllowed();
  if (!allowed.isAllowed) return null;
  const { address, error } = await getAddress();
  if (error || !address) return null;
  return address;
}
