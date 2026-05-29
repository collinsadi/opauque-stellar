import { create } from "zustand";
import { persist } from "zustand/middleware";

type NetworkType = "testnet" | "mainnet" | "futurenet" | "local" | "unknown";

interface SecurityState {
  hasBackedUp: boolean;
  hasAcknowledgedMainnetRisk: boolean;
  hasAcknowledgedReceiveRisk: boolean;
  expectedNetwork: NetworkType;
  
  setHasBackedUp: (val: boolean) => void;
  setHasAcknowledgedMainnetRisk: (val: boolean) => void;
  setHasAcknowledgedReceiveRisk: (val: boolean) => void;
  setExpectedNetwork: (val: NetworkType) => void;
}

export const useSecurityStore = create<SecurityState>()(
  persist(
    (set) => ({
      hasBackedUp: false,
      hasAcknowledgedMainnetRisk: false,
      hasAcknowledgedReceiveRisk: false,
      expectedNetwork: "testnet",
      
      setHasBackedUp: (val) => set({ hasBackedUp: val }),
      setHasAcknowledgedMainnetRisk: (val) => set({ hasAcknowledgedMainnetRisk: val }),
      setHasAcknowledgedReceiveRisk: (val) => set({ hasAcknowledgedReceiveRisk: val }),
      setExpectedNetwork: (val) => set({ expectedNetwork: val }),
    }),
    {
      name: "opaque-security-settings",
    }
  )
);
