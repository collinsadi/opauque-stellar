import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { Hex } from "../lib/stealth";
import { debugLog } from "../lib/debugLog";
import {
  deriveKeysFromSignature,
  keysToStealthMetaAddress,
  stealthMetaAddressToHex,
} from "../lib/stealth";
import type { MasterKeys } from "../lib/stealthLifecycle";
import { clearSignatureSession } from "../lib/signatureSession";

type KeysState = {
  /** Stealth meta-address (0x + 66 hex chars) to share with senders */
  stealthMetaAddressHex: Hex | null;
  /** Whether the user has completed setup (keys derived and stored in memory) */
  isSetup: boolean;
  /**
   * In-memory only: viewing and spending private keys.
   * Never persisted to localStorage; cleared on logout.
   */
  masterKeys: MasterKeys | null;
};

type KeysContextValue = KeysState & {
  setFromSignature: (signatureHex: Hex) => void;
  clearKeys: (options?: { preserveSession?: boolean }) => void;
  /** Get master keys for scanner/spender; only available when isSetup. */
  getMasterKeys: () => MasterKeys;
};

const KeysContext = createContext<KeysContextValue | null>(null);

export function KeysProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<KeysState>({
    stealthMetaAddressHex: null,
    isSetup: false,
    masterKeys: null,
  });

  const setFromSignature = useCallback((signatureHex: Hex) => {
    debugLog("🔑 [Opaque] Deriving keys from signature…");
    const { viewingKey, spendingKey } = deriveKeysFromSignature(signatureHex);
    const { metaAddress, S: spendPubKey } = keysToStealthMetaAddress(viewingKey, spendingKey);
    const metaHex = stealthMetaAddressToHex(metaAddress);
    setState({
      stealthMetaAddressHex: metaHex,
      isSetup: true,
      masterKeys: {
        viewPrivKey: viewingKey,
        spendPrivKey: spendingKey,
        spendPubKey: spendPubKey,
      },
    });
    debugLog("🔑 [Opaque] Keys derived, setup complete", { metaAddressHex: metaHex.slice(0, 18) + "…" });
  }, []);

  const clearKeys = useCallback((options?: { preserveSession?: boolean }) => {
    debugLog("🔑 [Opaque] Clearing keys (logout)");
    if (!options?.preserveSession) clearSignatureSession();
    setState({ stealthMetaAddressHex: null, isSetup: false, masterKeys: null });
  }, []);

  const getMasterKeys = useCallback((): MasterKeys => {
    if (!state.masterKeys) {
      throw new Error("Keys not set. Complete setup (sign message) first.");
    }
    return state.masterKeys;
  }, [state.masterKeys]);

  const value = useMemo<KeysContextValue>(
    () => ({
      ...state,
      setFromSignature,
      clearKeys,
      getMasterKeys,
    }),
    [state, setFromSignature, clearKeys, getMasterKeys]
  );

  return (
    <KeysContext.Provider value={value}>{children}</KeysContext.Provider>
  );
}

export function useKeys() {
  const ctx = useContext(KeysContext);
  if (!ctx) throw new Error("useKeys must be used within KeysProvider");
  return ctx;
}
