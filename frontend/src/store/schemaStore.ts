/**
 * Schema + V2 Attestation Store
 *
 * Zustand store for caching discovered schemas and V2 attestations locally.
 * Schemas are fetched from the schema_registry program via RPC.
 * V2 discovered traits come from the WASM scanner.
 */

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { SchemaV2 } from "../lib/schema";
import type { AttestationV2 } from "../lib/attestationV2";

// =============================================================================
// V2 discovered trait (from scanner WASM)
// =============================================================================

export interface V2DiscoveredTrait {
  stealthAddress: string;
  schemaId: string;
  schemaName: string;
  issuer: string;
  attestationUid: string;
  dataHex: string;
  nonce: string;
  /** Leaf preimage fields for the ZK prover */
  merkleLeafPreimage: {
    stealthPkField: string;
    schemaIdField: string;
    issuerPkX: string;
    traitDataHash: string;
    nonceField: string;
  };
  txHash: string;
  slot: number;
  isValid: boolean;
  issuerAuthorized: boolean;
  /** True = V2 attestation; false = legacy V1 */
  isV2: boolean;
  /**
   * True when the trait was matched from chain + owned stealth hash only.
   * Merkle preimage is unknown until a V2 announcement (0xB2 metadata) is observed.
   */
  chainDiscoveryOnly?: boolean;
}

// =============================================================================
// Store state & actions
// =============================================================================

interface SchemaStoreState {
  /** Schemas fetched from the registry (keyed by schemaId hex) */
  schemas: Record<string, SchemaV2>;
  /** V2 discovered traits from the scanner (keyed by attestationUid) */
  discoveredTraits: Record<string, V2DiscoveredTrait>;
  /** Attestation PDA data fetched from chain (keyed by uid) */
  attestations: Record<string, AttestationV2>;
  /** Whether a schema fetch is in progress */
  isFetchingSchemas: boolean;
  /** Whether a V2 scan is in progress */
  isScanning: boolean;
  /** Last scan slot */
  lastScannedSlot: number;

  // Actions
  setSchemas: (schemas: SchemaV2[]) => void;
  addSchema: (schema: SchemaV2) => void;
  setDiscoveredTraits: (traits: V2DiscoveredTrait[]) => void;
  addDiscoveredTrait: (trait: V2DiscoveredTrait) => void;
  markTraitInvalid: (attestationUid: string) => void;
  setAttestations: (attestations: AttestationV2[]) => void;
  setIsFetchingSchemas: (v: boolean) => void;
  setIsScanning: (v: boolean) => void;
  setLastScannedSlot: (slot: number) => void;
  clearTraits: () => void;
}

export const useSchemaStore = create<SchemaStoreState>()(
  persist(
    (set) => ({
      schemas: {},
      discoveredTraits: {},
      attestations: {},
      isFetchingSchemas: false,
      isScanning: false,
      lastScannedSlot: 0,

      setSchemas: (schemas) =>
        set({
          schemas: Object.fromEntries(schemas.map((s) => [s.schemaId, s])),
        }),

      addSchema: (schema) =>
        set((state) => ({
          schemas: { ...state.schemas, [schema.schemaId]: schema },
        })),

      setDiscoveredTraits: (traits) =>
        set({
          discoveredTraits: Object.fromEntries(
            traits.map((t) => [t.attestationUid, t])
          ),
        }),

      addDiscoveredTrait: (trait) =>
        set((state) => ({
          discoveredTraits: {
            ...state.discoveredTraits,
            [trait.attestationUid]: trait,
          },
        })),

      markTraitInvalid: (attestationUid) =>
        set((state) => {
          const trait = state.discoveredTraits[attestationUid];
          if (!trait) return state;
          return {
            discoveredTraits: {
              ...state.discoveredTraits,
              [attestationUid]: { ...trait, isValid: false },
            },
          };
        }),

      setAttestations: (attestations) =>
        set({
          attestations: Object.fromEntries(attestations.map((a) => [a.uid, a])),
        }),

      setIsFetchingSchemas: (v) => set({ isFetchingSchemas: v }),
      setIsScanning: (v) => set({ isScanning: v }),
      setLastScannedSlot: (slot) => set({ lastScannedSlot: slot }),
      clearTraits: () => set({ discoveredTraits: {} }),
    }),
    {
      name: "opaque-schema-store-v2",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        schemas: state.schemas,
        discoveredTraits: state.discoveredTraits,
        attestations: state.attestations,
        lastScannedSlot: state.lastScannedSlot,
      }),
    }
  )
);

// =============================================================================
// Selectors
// =============================================================================

/** Returns all schemas as a sorted array (most recent first) */
export function selectSchemasArray(state: SchemaStoreState): SchemaV2[] {
  return Object.values(state.schemas).sort((a, b) => b.createdAt - a.createdAt);
}

/** Returns all valid (non-revoked, non-expired) discovered traits */
export function selectValidTraits(state: SchemaStoreState): V2DiscoveredTrait[] {
  return Object.values(state.discoveredTraits).filter((t) => t.isValid && t.issuerAuthorized);
}

/** Returns schemas where the connected wallet is the authority or a delegate */
export function selectMySchemas(
  state: SchemaStoreState,
  walletAddress: string
): SchemaV2[] {
  return Object.values(state.schemas).filter(
    (s) => s.authority === walletAddress || s.delegates.includes(walletAddress)
  );
}
