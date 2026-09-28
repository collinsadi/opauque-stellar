/**
 * Syncs the connected wallet's public key into account-scoped stores.
 * Call once near the app root so all stores see the active account.
 */
import { useEffect } from "react";
import { useWallet } from "./useWallet";
import { usePoolNoteStore } from "../store/poolNoteStore";
import { useTxHistoryStore } from "../store/txHistoryStore";
import { useWatchlistStore } from "./useWatchlist";

export function useAccountScope(): void {
  const { publicKey } = useWallet();

  useEffect(() => {
    usePoolNoteStore.getState().setActiveAccount(publicKey ?? null);
    useTxHistoryStore.getState().setActiveAccount(publicKey ?? null);
    useWatchlistStore.getState().setActiveAccount(publicKey ?? null);
  }, [publicKey]);
}
