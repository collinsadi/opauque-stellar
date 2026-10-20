/**
 * React hook for loading and using the Opaque Cash WASM module.
 * 
 * Uses ES module import (via vite-plugin-wasm + vite-plugin-top-level-await)
 * and provides access to Rust functions:
 * - derive_stealth_address_wasm
 * - check_announcement_wasm
 * - check_announcement_view_tag_wasm
 */

import { useEffect, useState } from 'react';

// Type definitions for WASM module exports
export interface OpaqueWasmModule {
  derive_stealth_address_wasm: (
    view_privkey_bytes: Uint8Array,
    spend_pubkey_bytes: Uint8Array,
    ephemeral_pubkey_bytes: Uint8Array
  ) => {
    stealthAddress: string;
    viewTag: number;
  };
  check_announcement_wasm: (
    announcement_stealth_address: string,
    view_tag: number,
    view_privkey_bytes: Uint8Array,
    spend_pubkey_bytes: Uint8Array,
    ephemeral_pubkey_bytes: Uint8Array
  ) => boolean;
  check_announcement_view_tag_wasm: (
    view_tag: number,
    view_privkey_bytes: Uint8Array,
    ephemeral_pubkey_bytes: Uint8Array
  ) => string;
  reconstruct_signing_key_wasm: (
    master_spend_priv_bytes: Uint8Array,
    master_view_priv_bytes: Uint8Array,
    ephemeral_pubkey_bytes: Uint8Array
  ) => Uint8Array;
  scan_attestations_wasm: (
    announcements_json: string,
    view_privkey_bytes: Uint8Array,
    spend_pubkey_bytes: Uint8Array
  ) => string;
  scan_attestations_v2_wasm: (
    announcements_json: string,
    schemas_json: string,
    view_privkey_bytes: Uint8Array,
    spend_pubkey_bytes: Uint8Array,
    current_slot: bigint,
    trusted_issuers_json: string
  ) => string;
  generate_reputation_witness: (
    attestations_json: string,
    target_trait_id: string,
    stealth_privkey_bytes: Uint8Array,
    external_nullifier: string
  ) => string;
  encode_attestation_metadata_wasm: (
    view_tag: number,
    attestation_id: bigint
  ) => string;
  get_scanner_metadata: () => string;
  check_announcement_view_only_wasm: (
    announcement_stealth_address: string,
    view_tag: number,
    view_privkey_bytes: Uint8Array,
    spend_pubkey_bytes: Uint8Array,
    ephemeral_pubkey_bytes: Uint8Array
  ) => boolean;
}

interface UseOpaqueWasmReturn {
  wasm: OpaqueWasmModule | null;
  loading: boolean;
  error: Error | null;
  isReady: boolean;
}

/**
 * React hook that loads the Opaque Cash WASM module.
 * Uses ES module import; init() is called in useEffect so isReady is true only after init resolves.
 *
 * @returns Object containing the WASM module, loading state, error, and ready flag
 *
 * @example
 * ```tsx
 * const { wasm, loading, error, isReady } = useOpaqueWasm();
 *
 * if (loading) return <div>Loading WASM...</div>;
 * if (error) return <div>Error: {error.message}</div>;
 * if (!isReady) return null;
 *
 * const result = wasm.derive_stealth_address_wasm(
 *   viewKey,
 *   spendPubKey,
 *   ephemeralPubKey
 * );
 * ```
 */
export function useOpaqueWasm(): UseOpaqueWasmReturn {
  const [wasm, setWasm] = useState<OpaqueWasmModule | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        setLoading(true);
        setError(null);
        setWasm(null);

        const moduleUrl = new URL('pkg/opauque_scanner.js', document.baseURI).href;
        const loadedModule = await import(/* @vite-ignore */ moduleUrl) as unknown as
          Record<string, unknown> & { default: () => Promise<void> };

        // Must call default (async init) before any Rust functions; loads .wasm into memory
        await loadedModule.default();

        if (cancelled) return;

        console.log("✅ [Opaque] WASM binary initialized via Vite plugin");
        setWasm(loadedModule as unknown as OpaqueWasmModule);
        setLoading(false);
      } catch (err) {
        if (!cancelled) {
          const e = err instanceof Error ? err : new Error(String(err));
          setError(e);
          setWasm(null);
          setLoading(false);
          console.error("⚠️ [Opaque] WASM load failed:", e);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // isReady is true only when init() has resolved and .wasm is in memory
  const isReady = Boolean(wasm !== null && !loading && error === null);

  return {
    wasm,
    loading,
    error,
    isReady,
  };
}

/**
 * Helper function to derive a stealth address using the WASM module.
 * 
 * @param wasm - The WASM module instance
 * @param viewPrivKey - 32-byte viewing private key
 * @param spendPubKey - 33-byte spending public key (compressed)
 * @param ephemeralPubKey - 33-byte ephemeral public key (compressed)
 * @returns Object with stealthAddress (hex string) and viewTag (number)
 */
export function deriveStealthAddress(
  wasm: OpaqueWasmModule,
  viewPrivKey: Uint8Array,
  spendPubKey: Uint8Array,
  ephemeralPubKey: Uint8Array
): { stealthAddress: string; viewTag: number } {
  if (viewPrivKey.length !== 32) {
    throw new Error('View private key must be 32 bytes');
  }
  if (spendPubKey.length !== 33) {
    throw new Error('Spend public key must be 33 bytes (compressed)');
  }
  if (ephemeralPubKey.length !== 33) {
    throw new Error('Ephemeral public key must be 33 bytes (compressed)');
  }

  return wasm.derive_stealth_address_wasm(viewPrivKey, spendPubKey, ephemeralPubKey);
}

/**
 * Helper function to check if an announcement matches this recipient.
 * 
 * @param wasm - The WASM module instance
 * @param announcementStealthAddress - Stealth address from announcement (hex string)
 * @param viewTag - View tag from announcement (0-255)
 * @param viewPrivKey - 32-byte viewing private key
 * @param spendPubKey - 33-byte spending public key (compressed)
 * @param ephemeralPubKey - 33-byte ephemeral public key (compressed)
 * @returns true if the announcement is for this recipient
 */
export function checkAnnouncement(
  wasm: OpaqueWasmModule,
  announcementStealthAddress: string,
  viewTag: number,
  viewPrivKey: Uint8Array,
  spendPubKey: Uint8Array,
  ephemeralPubKey: Uint8Array
): boolean {
  if (viewPrivKey.length !== 32) {
    throw new Error('View private key must be 32 bytes');
  }
  if (spendPubKey.length !== 33) {
    throw new Error('Spend public key must be 33 bytes (compressed)');
  }
  if (ephemeralPubKey.length !== 33) {
    throw new Error('Ephemeral public key must be 33 bytes (compressed)');
  }
  if (viewTag < 0 || viewTag > 255) {
    throw new Error('View tag must be between 0 and 255');
  }

  return wasm.check_announcement_wasm(
    announcementStealthAddress,
    viewTag,
    viewPrivKey,
    spendPubKey,
    ephemeralPubKey
  );
}

/**
 * Helper function to quickly check view tag before expensive operations.
 * 
 * @param wasm - The WASM module instance
 * @param viewTag - View tag from announcement (0-255)
 * @param viewPrivKey - 32-byte viewing private key
 * @param ephemeralPubKey - 33-byte ephemeral public key (compressed)
 * @returns 'NoMatch' if view tag doesn't match, 'PossibleMatch' if it matches
 */
export function checkAnnouncementViewTag(
  wasm: OpaqueWasmModule,
  viewTag: number,
  viewPrivKey: Uint8Array,
  ephemeralPubKey: Uint8Array
): 'NoMatch' | 'PossibleMatch' {
  if (viewPrivKey.length !== 32) {
    throw new Error('View private key must be 32 bytes');
  }
  if (ephemeralPubKey.length !== 33) {
    throw new Error('Ephemeral public key must be 33 bytes (compressed)');
  }
  if (viewTag < 0 || viewTag > 255) {
    throw new Error('View tag must be between 0 and 255');
  }

  const result = wasm.check_announcement_view_tag_wasm(viewTag, viewPrivKey, ephemeralPubKey);
  return result === "NoMatch" ? "NoMatch" : "PossibleMatch";
}
