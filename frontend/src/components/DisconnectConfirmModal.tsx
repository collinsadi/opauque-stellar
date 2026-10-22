/**
 * Modal shown when the user clicks "Disconnect" to choose between a simple
 * disconnect (keys only) and a full local-data wipe.
 *
 * Mounted once at the App root so it works from every screen (#1116). Uses
 * ModalShell for dialog semantics, focus trap and Escape handling (#1115).
 */

import { useId, useState } from "react";
import { ModalShell } from "./ModalShell";
import { NOTE_LOSS_PHRASE, canFullWipe } from "../lib/disconnectCleanup";

type Props = {
  /** Unspent privacy pool notes across all accounts. A full wipe deletes them. */
  unspentNoteCount: number;
  onDisconnectOnly: () => void;
  onFullWipe: () => void;
  onCancel: () => void;
};

/** Mirrors what `wipeSensitiveLocalData` and the App's store resets remove. */
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
  "Signing audit log",
  "Encryption passphrase (session memory)",
  "Other app preferences (display, tour, diagnostics consent)",
];

/** Mirrors `PRESERVED_LOCAL_STORAGE_KEYS` in lib/disconnectCleanup.ts. */
const KEPT_ITEMS = [
  "Security preferences (network, backup acknowledgment)",
  "UI locale preference",
];

export function DisconnectConfirmModal({
  unspentNoteCount,
  onDisconnectOnly,
  onFullWipe,
  onCancel,
}: Props) {
  const [typedAcknowledgment, setTypedAcknowledgment] = useState("");
  const acknowledgmentId = useId();
  const wipeAllowed = canFullWipe({ unspentNoteCount, typedAcknowledgment });

  return (
    <ModalShell
      open
      onClose={onCancel}
      title="Disconnect wallet"
      description="Choose how much local data to remove. A full wipe is recommended if another person may use this browser."
    >
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

      <div className="mb-4 rounded-xl border border-ink-700 bg-ink-900/30 p-3">
        <p className="text-xs font-medium text-neutral-300 mb-1.5 uppercase tracking-wider">
          Always kept
        </p>
        <ul className="text-xs text-mist space-y-0.5 list-disc pl-4">
          {KEPT_ITEMS.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>

      {unspentNoteCount > 0 ? (
        <div className="mb-5 space-y-2 rounded-xl border border-red-500/40 bg-red-950/20 p-3">
          <p className="text-xs leading-relaxed text-red-100/90">
            This browser holds {unspentNoteCount} unspent privacy pool{" "}
            {unspentNoteCount === 1 ? "note" : "notes"}. Each note is a spending secret, and
            without it the deposited funds cannot be withdrawn. A full wipe deletes them.
          </p>
          <label htmlFor={acknowledgmentId} className="block text-xs text-red-100/90">
            Type <strong>{NOTE_LOSS_PHRASE}</strong> to confirm you accept losing them.
          </label>
          <input
            id={acknowledgmentId}
            type="text"
            autoComplete="off"
            value={typedAcknowledgment}
            onChange={(e) => setTypedAcknowledgment(e.target.value)}
            className="w-full rounded-lg border border-ink-600 bg-ink-950 px-3 py-2 text-sm text-white"
          />
        </div>
      ) : null}

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
          disabled={!wipeAllowed}
          className="px-4 py-2 rounded-xl text-sm font-semibold bg-red-600 border border-red-600 text-white hover:bg-red-700 transition-colors disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-red-600"
        >
          Disconnect & wipe all data
        </button>
      </div>
    </ModalShell>
  );
}
