import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { getFeatureFlags } from "../lib/featureFlags";

export type ProtocolLogSource = "wasm" | "blockchain" | "ui";

export type ProtocolLogEntry = {
  id: string;
  source: ProtocolLogSource;
  message: string;
  timestamp: number;
};

type ProtocolLogContextValue = {
  entries: ProtocolLogEntry[];
  push: (source: ProtocolLogSource, message: string) => void;
  clear: () => void;
};

const ProtocolLogContext = createContext<ProtocolLogContextValue | null>(null);

let idCounter = 0;
function nextId() {
  idCounter += 1;
  return `log-${idCounter}-${Date.now()}`;
}

export function ProtocolLogProvider({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<ProtocolLogEntry[]>([]);

  const push = useCallback((source: ProtocolLogSource, message: string) => {
    if (!getFeatureFlags().debugLogs) return;
    setEntries((prev) =>
      prev.concat({
        id: nextId(),
        source,
        message,
        timestamp: Date.now(),
      })
    );
  }, []);

  const clear = useCallback(() => setEntries([]), []);

  const value = useMemo(
    () => ({ entries, push, clear }),
    [entries, push, clear]
  );

  return (
    <ProtocolLogContext.Provider value={value}>
      {children}
    </ProtocolLogContext.Provider>
  );
}

export function useProtocolLog(): ProtocolLogContextValue {
  const ctx = useContext(ProtocolLogContext);
  if (!ctx) {
    return {
      entries: [],
      push: () => {},
      clear: () => {},
    };
  }
  return ctx;
}
