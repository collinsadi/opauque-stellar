/**
 * useFreezeStatus — tracks whether the reputation Merkle root is frozen
 * (expired / unavailable) or stale, so live proof flows can block or warn.
 *
 * Polling pauses while the document is hidden to avoid wasted RPC calls.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchLatestValidMerkleRoot,
  isReputationRootUnavailableError,
  REPUTATION_ROOT_UNAVAILABLE_MESSAGE,
} from "../lib/reputationProver";

export interface FreezeStatus {
  /** True while the root is frozen (expired / unavailable on-chain). */
  frozen: boolean;
  /** True when the root is older than the freshness threshold. */
  stale: boolean;
  /** Human-readable explanation when frozen or stale. */
  message: string | null;
  /** True while a check is in flight. */
  checking: boolean;
  /** Timestamp of the last successful check (ms). */
  lastCheckedAt: number | null;
  /** Re-run the check now. */
  refresh: () => void;
}

const POLL_INTERVAL_MS = 30_000;
const STALE_AFTER_MS = 20 * 60_000;

export function useFreezeStatus(sourcePublicKey: string | null | undefined): FreezeStatus {
  const [frozen, setFrozen] = useState(false);
  const [stale, setStale] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const visibleRef = useRef(true);
  const lastSuccessAtRef = useRef<number | null>(null);

  const refresh = useCallback(() => setRefreshNonce((n) => n + 1), []);

  useEffect(() => {
    const onVisibility = () => {
      visibleRef.current = document.visibilityState === "visible";
      if (visibleRef.current) refresh();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [refresh]);

  useEffect(() => {
    if (!sourcePublicKey) return;
    let cancelled = false;

    const check = async () => {
      if (!visibleRef.current) return;
      setChecking(true);
      try {
        await fetchLatestValidMerkleRoot(sourcePublicKey);
        if (cancelled) return;
        setFrozen(false);
        setMessage(null);
        setLastCheckedAt(Date.now());
        lastSuccessAtRef.current = Date.now();
        setStale(false);
      } catch (err) {
        if (cancelled) return;
        const unavailable =
          isReputationRootUnavailableError(err) ||
          (err instanceof Error && err.message === REPUTATION_ROOT_UNAVAILABLE_MESSAGE);
        if (unavailable) {
          setFrozen(true);
          setStale(true);
          setMessage(
            "The reputation root is currently frozen (expired or unpublished). Proof generation is disabled until a fresh root is published.",
          );
        } else {
          // Unknown error: surface staleness if the last good check is old.
          const lastOk = lastSuccessAtRef.current;
          const isStale = lastOk !== null && Date.now() - lastOk > STALE_AFTER_MS;
          setStale(isStale);
          setMessage(
            isStale
              ? "The reputation root status could not be verified and the last successful check is stale. Proof generation may fail."
              : null,
          );
        }
        setLastCheckedAt(Date.now());
      } finally {
        if (!cancelled) setChecking(false);
      }
    };

    void check();
    const timer = setInterval(() => {
      if (visibleRef.current) void check();
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [sourcePublicKey, refreshNonce]);

  return { frozen, stale, message, checking, lastCheckedAt, refresh };
}
