import { createContext, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  getPublicKey,
  isConnected as freighterIsConnected,
} from "@stellar/freighter-api";
import { getNetworkPassphrase } from "../lib/chain";
import { getSorobanServer } from "../lib/stellar";
import type { SignTxFn } from "../lib/stellar";
import { FreighterAdapter, type WalletAdapter } from "../lib/walletAdapters";

export type ScannerSelfTestStatus = "idle" | "running" | "pass" | "fail";

export type StellarWalletContextValue = {
  publicKey: string | null;
  connected: boolean;
  connecting: boolean;
  /** Id of the currently active wallet adapter (e.g. "freighter", "lobstr"). */
  activeWalletId: string | null;
  /**
   * Connect using a specific adapter. When omitted, opens the wallet picker
   * (callers should render WalletPickerModal and call connectWithAdapter directly).
   */
  connectWithAdapter: (adapter: WalletAdapter) => Promise<string>;
  /** Legacy: connects with the default Freighter adapter — keeps existing callers working. */
  connect: () => Promise<string>;
  disconnect: () => void;
  signTransaction: SignTxFn;
  signMessage: ((message: Uint8Array) => Promise<Uint8Array>) | null;
  /** Scanner health: WASM init + single ledger probe, run once per session after connect. */
  selfTestStatus: ScannerSelfTestStatus;
  selfTestError: string | null;
};

/** Runs once per session after wallet connect: WASM init probe + ledger RPC probe. */
async function runScannerSelfTest(): Promise<void> {
  const loadedModule = await (Function('return import("/pkg/cryptography.js")')() as Promise<
    Record<string, unknown> & { default: () => Promise<void> }
  >);
  await loadedModule.default();
  const server = getSorobanServer();
  await server.getLatestLedger();
}

export const StellarWalletContext = createContext<StellarWalletContextValue | null>(null);

export function StellarWalletProviders({ children }: { children: ReactNode }) {
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [activeWalletId, setActiveWalletId] = useState<string | null>(null);
  const activeAdapterRef = useRef<WalletAdapter>(FreighterAdapter);
  const connectInFlightRef = useRef(false);

  const [selfTestStatus, setSelfTestStatus] = useState<ScannerSelfTestStatus>("idle");
  const [selfTestError, setSelfTestError] = useState<string | null>(null);
  const selfTestRanRef = useRef(false);

  useEffect(() => {
    if (!connected || selfTestRanRef.current) return;
    selfTestRanRef.current = true;
    setSelfTestStatus("running");
    runScannerSelfTest()
      .then(() => setSelfTestStatus("pass"))
      .catch((err: unknown) => {
        setSelfTestError(err instanceof Error ? err.message : String(err));
        setSelfTestStatus("fail");
      });
  }, [connected]);

  const connectWithAdapter = useCallback(async (adapter: WalletAdapter): Promise<string> => {
    if (connectInFlightRef.current) {
      return publicKey ?? "";
    }
    connectInFlightRef.current = true;
    setConnecting(true);
    try {
      const pk = await adapter.connect();
      activeAdapterRef.current = adapter;
      setPublicKey(pk);
      setConnected(true);
      setActiveWalletId(adapter.id);
      return pk;
    } finally {
      setConnecting(false);
      connectInFlightRef.current = false;
    }
  }, [publicKey]);

  /** Backwards-compatible connect() always uses Freighter. */
  const connect = useCallback(() => connectWithAdapter(FreighterAdapter), [connectWithAdapter]);

  const disconnect = useCallback(() => {
    setPublicKey(null);
    setConnected(false);
    setActiveWalletId(null);
    activeAdapterRef.current = FreighterAdapter;
    selfTestRanRef.current = false;
  }, []);

  const signTx: SignTxFn = useCallback(async (xdr: string) => {
    return activeAdapterRef.current.signTransaction(xdr, {
      networkPassphrase: getNetworkPassphrase(),
      accountToSign: publicKey ?? undefined,
    });
  }, [publicKey]);

  const signMessage = useCallback(async (message: Uint8Array) => {
    return activeAdapterRef.current.signMessage(message, {
      accountToSign: publicKey ?? undefined,
    });
  }, [publicKey]);

  const value = useMemo(
    () => ({
      publicKey,
      connected,
      connecting,
      activeWalletId,
      connectWithAdapter,
      connect,
      disconnect,
      signTransaction: signTx,
      signMessage,
      selfTestStatus,
      selfTestError,
    }),
    [publicKey, connected, connecting, activeWalletId, connectWithAdapter, connect, disconnect, signTx, signMessage, selfTestStatus, selfTestError],
  );

  return (
    <StellarWalletContext.Provider value={value}>{children}</StellarWalletContext.Provider>
  );
}

export async function tryRestoreFreighterSession(): Promise<string | null> {
  const ok = await freighterIsConnected();
  if (!ok) return null;
  try {
    return await getPublicKey();
  } catch {
    return null;
  }
}
