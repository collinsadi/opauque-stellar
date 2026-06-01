/**
 * Zustand store for stealth reputation / verified traits.
 *
 * Persists discovered traits to localStorage so they survive page reloads.
 * Proof state is ephemeral (lost on reload — proofs should be submitted on-chain).
 */

import { create } from "zustand";
import type { DiscoveredTrait, ProofState, ProofData } from "../lib/reputation";
import { writeLocalStorage } from "../lib/storageHealth";

interface ReputationState {
  discoveredTraits: DiscoveredTrait[];
  proofState: ProofState;
  lastScanTimestamp: number | null;

  setDiscoveredTraits: (traits: DiscoveredTrait[]) => void;
  addDiscoveredTrait: (trait: DiscoveredTrait) => void;
  clearTraits: () => void;

  setProofStage: (stage: ProofState["stage"], progress?: number) => void;
  setProofError: (error: string) => void;
  setProofReady: (proof: ProofData) => void;
  resetProof: () => void;
  startProof: (traitId: string) => void;

  setLastScanTimestamp: (ts: number) => void;
}

const STORAGE_KEY = "opaque-reputation-traits";

function loadPersistedTraits(): DiscoveredTrait[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as DiscoveredTrait[];
  } catch {
    return [];
  }
}

let _traitPersistListener: ((message: string) => void) | null = null;

export function setReputationPersistListener(
  listener: ((message: string) => void) | null,
): void {
  _traitPersistListener = listener;
}

function persistTraits(traits: DiscoveredTrait[]) {
  const result = writeLocalStorage(STORAGE_KEY, JSON.stringify(traits));
  if (!result.ok) _traitPersistListener?.(result.message);
}

const initialProofState: ProofState = {
  stage: "idle",
  progress: 0,
  traitId: null,
  error: null,
  proof: null,
};

export const useReputationStore = create<ReputationState>((set) => ({
  discoveredTraits: loadPersistedTraits(),
  proofState: { ...initialProofState },
  lastScanTimestamp: null,

  setDiscoveredTraits: (traits) => {
    persistTraits(traits);
    set({ discoveredTraits: traits });
  },

  addDiscoveredTrait: (trait) =>
    set((state) => {
      const exists = state.discoveredTraits.some(
        (t) => t.txHash === trait.txHash && t.attestationId === trait.attestationId
      );
      if (exists) return state;
      const next = [...state.discoveredTraits, trait];
      persistTraits(next);
      return { discoveredTraits: next };
    }),

  clearTraits: () => {
    localStorage.removeItem(STORAGE_KEY);
    set({ discoveredTraits: [] });
  },

  setProofStage: (stage, progress) =>
    set((state) => ({
      proofState: {
        ...state.proofState,
        stage,
        progress: progress ?? state.proofState.progress,
        error: null,
      },
    })),

  setProofError: (error) =>
    set((state) => ({
      proofState: { ...state.proofState, stage: "error", error },
    })),

  setProofReady: (proof) =>
    set((state) => ({
      proofState: {
        ...state.proofState,
        stage: "proof-ready",
        progress: 100,
        proof,
      },
    })),

  resetProof: () => set({ proofState: { ...initialProofState } }),

  startProof: (traitId) =>
    set({
      proofState: {
        stage: "preparing-witness",
        progress: 0,
        traitId,
        error: null,
        proof: null,
      },
    }),

  setLastScanTimestamp: (ts) => set({ lastScanTimestamp: ts }),
}));
