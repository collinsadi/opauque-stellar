/**
 * Modal shown when the user clicks "Disconnect" to choose between a simple
 * disconnect (keys only) and a full local-data wipe.
 */

type Props = {
  onDisconnectOnly: () => void;
  onFullWipe: () => void;
  onCancel: () => void;
};

const WIPED_ITEMS = [
  "Master signing keys (session memory)",
  "Vault entries (stealth addresses & balances)",
  "Transaction history",
  "Pool notes (spending secrets)",
  "Ghost addresses & ephemeral keys",
  "Watchlist entries",
  "Discovered reputation traits & issued attestations",
  "Schema cache & discovered traits",
  "Pending transactions",
  "IndexedDB announcement cache & sync state",
  "Encryption passphrase (session memory)",
];

const KEPT_ITEMS = [
  "Security preferences (network, backup acknowledgment)",
  "UI locale preference",
];

export function DisconnectConfirmModal({
  onDisconnectOnly,
  onFullWipe,
  onCancel,
}: Props) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-ink-700 bg-ink-950 p-6 shadow-2xl">
        <h2 className="font-display text-lg font-bold text-white mb-2">
          Disconnect wallet
        </h2>
        <p className="text-sm text-mist mb-4">
          Choose how much local data to remove. A full wipe is recommended if
          another person may use this browser.
        </p>

        <div className="mb-4 rounded-xl border border-ink-700 bg-ink-900/30 p-3">
          <p className="text-xs font-medium text-neutral-300 mb-1.5 uppercase tracking-wider">
            Full wipe removes
          </p>
          <ul className="text-xs text-mist space-y-0.5 list-disc pl-4">
            {WIPED_ITEMS.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>

        <div className="mb-5 rounded-xl border border-ink-700 bg-ink-900/30 p-3">
          <p className="text-xs font-medium text-neutral-300 mb-1.5 uppercase tracking-wider">
            Always kept
          </p>
          <ul className="text-xs text-mist space-y-0.5 list-disc pl-4">
            {KEPT_ITEMS.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>

        <div className="flex flex-wrap gap-2 justify-end">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 rounded-xl text-sm font-medium text-mist border border-ink-600 bg-ink-950/30 hover:border-white/30 hover:text-white transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onDisconnectOnly}
            className="px-4 py-2 rounded-xl text-sm font-medium text-mist border border-ink-600 bg-ink-950/30 hover:border-white/30 hover:text-white transition-colors"
          >
            Disconnect only
          </button>
          <button
            type="button"
            onClick={onFullWipe}
            className="px-4 py-2 rounded-xl text-sm font-semibold bg-red-600 border border-red-600 text-white hover:bg-red-700 transition-colors"
          >
            Disconnect & wipe all data
          </button>
        </div>
      </div>
    </div>
  );
}
