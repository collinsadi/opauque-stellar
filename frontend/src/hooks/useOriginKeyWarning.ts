/**
 * useOriginKeyWarning: detects when the wallet's registered meta-address
 * does not match keys derived on the current origin (issue #1138).
 *
 * The key-derivation message includes `Origin: ${window.location.origin}`,
 * so a domain move, preview deployment, or mirror silently gives users a
 * new identity and payments sent to the old meta-address stop appearing.
 */

import { useState, useEffect, useCallback } from "react";

const CANONICAL_ORIGIN_KEY = "opauque_canonical_origin";
const META_ADDRESS_KEY = "opauque_meta_address";

export interface OriginKeyWarning {
  /** True when the current origin differs from the canonical origin used at registration */
  hasOriginMismatch: boolean;
  /** The canonical origin the keys were originally derived on */
  canonicalOrigin: string | null;
  /** The current origin */
  currentOrigin: string;
  /** Dismiss the warning for this session */
  dismiss: () => void;
  /** Store the current origin as canonical (migration path) */
  migrateToCurrentOrigin: () => void;
}

export function useOriginKeyWarning(): OriginKeyWarning {
  const currentOrigin = typeof window !== "undefined" ? window.location.origin : "";
  const [hasOriginMismatch, setHasOriginMismatch] = useState(false);
  const [canonicalOrigin, setCanonicalOrigin] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem(CANONICAL_ORIGIN_KEY);
    const metaAddress = localStorage.getItem(META_ADDRESS_KEY);

    if (stored && metaAddress) {
      setCanonicalOrigin(stored);
      if (stored !== currentOrigin) {
        setHasOriginMismatch(true);
      }
    } else if (metaAddress) {
      // First time checking — store current origin as canonical
      localStorage.setItem(CANONICAL_ORIGIN_KEY, currentOrigin);
      setCanonicalOrigin(currentOrigin);
    }
  }, [currentOrigin]);

  const dismiss = useCallback(() => setDismissed(true), []);

  const migrateToCurrentOrigin = useCallback(() => {
    localStorage.setItem(CANONICAL_ORIGIN_KEY, currentOrigin);
    setCanonicalOrigin(currentOrigin);
    setHasOriginMismatch(false);
    setDismissed(true);
  }, [currentOrigin]);

  return {
    hasOriginMismatch: hasOriginMismatch && !dismissed,
    canonicalOrigin,
    currentOrigin,
    dismiss,
    migrateToCurrentOrigin,
  };
}
