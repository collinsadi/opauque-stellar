import { create } from "zustand";
import { persist } from "zustand/middleware";
import { DEFAULT_CLIPBOARD_CLEAR_TIMEOUT_MS } from "../lib/clipboardSafety";

type NetworkType = "testnet" | "mainnet" | "futurenet" | "local" | "unknown";

interface SecurityState {
  hasBackedUp: boolean;
  hasAcknowledgedMainnetRisk: boolean;
  hasAcknowledgedReceiveRisk: boolean;
  expectedNetwork: NetworkType;
  sensitiveCopyWarningEnabled: boolean;
  clipboardClearTimeoutMs: number;
  
  setHasBackedUp: (val: boolean) => void;
  setHasAcknowledgedMainnetRisk: (val: boolean) => void;
  setHasAcknowledgedReceiveRisk: (val: boolean) => void;
  setExpectedNetwork: (val: NetworkType) => void;
  setSensitiveCopyWarningEnabled: (val: boolean) => void;
  setClipboardClearTimeoutMs: (val: number) => void;
}

export const useSecurityStore = create<SecurityState>()(
  persist(
    (set) => ({
      hasBackedUp: false,
      hasAcknowledgedMainnetRisk: false,
      hasAcknowledgedReceiveRisk: false,
      expectedNetwork: "testnet",
      sensitiveCopyWarningEnabled: true,
      clipboardClearTimeoutMs: DEFAULT_CLIPBOARD_CLEAR_TIMEOUT_MS,
      
      setHasBackedUp: (val) => set({ hasBackedUp: val }),
      setHasAcknowledgedMainnetRisk: (val) => set({ hasAcknowledgedMainnetRisk: val }),
      setHasAcknowledgedReceiveRisk: (val) => set({ hasAcknowledgedReceiveRisk: val }),
      setExpectedNetwork: (val) => set({ expectedNetwork: val }),
      setSensitiveCopyWarningEnabled: (val) => set({ sensitiveCopyWarningEnabled: val }),
      setClipboardClearTimeoutMs: (val) => set({ clipboardClearTimeoutMs: val }),
    }),
    {
      name: "opaque-security-settings",
    }
  )
);