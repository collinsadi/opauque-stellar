/**
 * Attestations issued on-chain whose local record or recipient announcement is
 * still outstanding (see lib/pendingAttestations.ts). Persisted so recovery
 * continues after a reload. Entries are removed once fully recorded.
 *
 * These records hold only public attestation metadata (no secrets), encrypted
 * at rest like the issued-attestation store.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createEncryptedStorage } from "../lib/encryptedStorage";
import { getEncryptionPassphrase } from "../lib/getEncryptionPassphrase";
import type { PendingAttestation } from "../lib/pendingAttestations";

type PendingAttestationState = {
  pending: PendingAttestation[];
  /** Insert or replace the record for `(cluster, txHash)`. */
  upsert: (record: PendingAttestation) => void;
  remove: (cluster: string, txHash: string) => void;
  getForCluster: (cluster: string) => PendingAttestation[];
};

const PENDING_ATTESTATION_STORAGE_KEY = "opaque-pending-attestations-v1";

const pendingAttestationStorage = createEncryptedStorage<PendingAttestationState>(
  PENDING_ATTESTATION_STORAGE_KEY,
  getEncryptionPassphrase,
);

const isSameRecord = (a: PendingAttestation, cluster: string, txHash: string) =>
  a.cluster === cluster && a.txHash === txHash;

export const usePendingAttestationStore = create<PendingAttestationState>()(
  persist(
    (set, get) => ({
      pending: [],
      upsert: (record) =>
        set((s) => ({
          pending: [
            record,
            ...s.pending.filter((x) => !isSameRecord(x, record.cluster, record.txHash)),
          ],
        })),
      remove: (cluster, txHash) =>
        set((s) => ({
          pending: s.pending.filter((x) => !isSameRecord(x, cluster, txHash)),
        })),
      getForCluster: (cluster) => get().pending.filter((x) => x.cluster === cluster),
    }),
    {
      name: PENDING_ATTESTATION_STORAGE_KEY,
      storage: pendingAttestationStorage,
    },
  ),
);
