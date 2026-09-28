/**
 * Checks whether the connected wallet has a stealth meta-address registered on the current cluster.
 * Re-runs automatically when address or cluster changes.
 */

import { useState, useEffect, useCallback } from "react";
import { isRegistered } from "../lib/registry";
import type { Hex } from "../lib/stealth";

export type RegistrationStatus = {
  isRegistered: boolean;
  isLoading: boolean;
  error: string | null;
  retry: () => void;
};

export function useRegistrationStatus(
  address: string | null,
  cluster: string | null,
  expectedMetaAddress?: Hex | null,
): RegistrationStatus {
  const [isRegisteredOnChain, setIsRegisteredOnChain] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    if (!address || cluster == null) {
      setIsRegisteredOnChain(false);
      setError(null);
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    setError(null);

    isRegistered(address, expectedMetaAddress)
      .then((registered) => {
        if (!cancelled) {
          setIsRegisteredOnChain(registered);
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setIsRegisteredOnChain(false);
          setError(reason instanceof Error ? reason.message : "Registry status is temporarily unavailable.");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [address, cluster, expectedMetaAddress, attempt]);

  return { isRegistered: isRegisteredOnChain, isLoading, error, retry };
}
