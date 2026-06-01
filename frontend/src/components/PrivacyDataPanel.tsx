import { useState } from "react";
import {
  CLEAR_ON_PRIVACY_WIPE,
  PERSIST_ON_DISCONNECT,
  clearAllLocalSensitiveData,
} from "../lib/localDataManager";
import { useKeys } from "../context/KeysContext";
import { useVaultStore } from "../store/vaultStore";
import { useWallet } from "../hooks/useWallet";

type Props = {
  onDisconnect?: () => void;
};

export function PrivacyDataPanel({ onDisconnect }: Props) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const { clearKeys } = useKeys();
  const clearVault = useVaultStore((s) => s.clear);
  const { disconnect } = useWallet();

  const handleClear = async () => {
    setBusy(true);
    try {
      clearKeys();
      clearVault();
      await clearAllLocalSensitiveData();
      disconnect();
      onDisconnect?.();
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-2xl border border-ink-700 bg-ink-900/25 p-5">
      <h3 className="font-display text-lg font-semibold text-white mb-2">
        Local data & privacy
      </h3>
      <p className="text-sm text-mist mb-4 leading-relaxed">
        Disconnecting clears in-memory master keys and the vault only. Ghost
        addresses, history, and announcement cache stay on this device until you
        clear them.
      </p>

      <div className="mb-4 grid gap-3 sm:grid-cols-2 text-xs">
        <div className="rounded-xl border border-ink-700 bg-ink-950/40 p-3">
          <p className="font-medium text-white mb-2">Stays after disconnect</p>
          <ul className="list-disc list-inside text-mist space-y-1">
            {PERSIST_ON_DISCONNECT.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
        <div className="rounded-xl border border-ink-700 bg-ink-950/40 p-3">
          <p className="font-medium text-white mb-2">Removed by clear local data</p>
          <ul className="list-disc list-inside text-mist space-y-1">
            {CLEAR_ON_PRIVACY_WIPE.slice(0, 5).map((item) => (
              <li key={item}>{item}</li>
            ))}
            <li className="text-mist/70">…and all other Opaque caches</li>
          </ul>
        </div>
      </div>

      <a
        href="https://github.com/collinsadi/opaque-stellar/blob/main/docs/LOCAL_DATA_AND_DISCONNECT.md"
        target="_blank"
        rel="noopener noreferrer"
        className="text-xs text-sol-purple hover:underline"
      >
        Full disconnect & privacy documentation
      </a>

      {!confirming ? (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="mt-4 w-full rounded-xl border border-error/40 px-4 py-2.5 text-sm font-medium text-error hover:bg-error/10 transition-colors"
        >
          Clear all local data
        </button>
      ) : (
        <div className="mt-4 space-y-2">
          <p className="text-xs text-amber-200">
            This cannot be undone. Export ghost backups first if you use manual
            ghost receives.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleClear()}
              className="flex-1 rounded-xl bg-error/90 px-4 py-2.5 text-sm font-semibold text-white hover:bg-error disabled:opacity-50"
            >
              {busy ? "Clearing…" : "Confirm wipe"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirming(false)}
              className="rounded-xl border border-ink-600 px-4 py-2.5 text-sm text-mist hover:text-white"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
