/**
 * Records attestations issued by this wallet so the Manage page can list and
 * revoke them. The attestation engine has no on-chain "by issuer" index, so the
 * issuer side is tracked client-side (persisted to localStorage) at issuance
 * time. Received attestations are discovered separately by the scanner.
 *
 * These records hold only public attestation metadata (no secrets).
 * Data is encrypted at rest using passphrase-derived AES-256-GCM.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createEncryptedStorage } from "../lib/encryptedStorage";
import { getEncryptionPassphrase } from "../lib/getEncryptionPassphrase";

export type IssuedAttestation = {
  cluster: string;
  /** 0x-prefixed 32-byte attestation UID. */
  uidHex: string;
  /** Schema id (as stored on the schema record). */
  schemaIdHex: string;
  schemaName: string;
  /** 0x-prefixed 32-byte recipient stealth-address hash. */
  stealthAddressHashHex: string;
  /** Ledger sequence at issuance (best effort). */
  createdAtSlot: number;
  /** Expiration ledger, 0 = never. */
  expirationSlot: number;
  isRevocable: boolean;
  revoked: boolean;
  txHash: string;
};

type IssuedAttestationState = {
  issued: IssuedAttestation[];
  addIssued: (a: IssuedAttestation) => void;
  /** Upsert many records at once (chain sync), keeping any not in the batch. */
  mergeIssued: (list: IssuedAttestation[]) => void;
  markRevoked: (uidHex: string, cluster: string) => void;
  getForCluster: (cluster: string) => IssuedAttestation[];
};

const ISSUED_ATTESTATION_STORAGE_KEY = "opaque-issued-attestations-v1";

const issuedAttestationStorage = createEncryptedStorage<IssuedAttestationState>(
  ISSUED_ATTESTATION_STORAGE_KEY,
  getEncryptionPassphrase,
);

export const useIssuedAttestationStore = create<IssuedAttestationState>()(
  persist(
    (set, get) => ({
      issued: [],
      addIssued: (a) =>
        set((s) => ({
          issued: [
            a,
            ...s.issued.filter(
              (x) => !(x.uidHex === a.uidHex && x.cluster === a.cluster),
            ),
          ],
        })),
      mergeIssued: (list) =>
        set((s) => {
          const byKey = new Map<string, IssuedAttestation>();
          const keyOf = (x: IssuedAttestation) => `${x.cluster}:${x.uidHex}`;
          for (const x of s.issued) byKey.set(keyOf(x), x);
          // Incoming chain records are authoritative for shared fields, but keep
          // a locally recorded txHash if the chain record could not supply one.
          for (const x of list) {
            const prev = byKey.get(keyOf(x));
            byKey.set(keyOf(x), {
              ...x,
              txHash: x.txHash || prev?.txHash || "",
            });
          }
          return { issued: Array.from(byKey.values()) };
        }),
      markRevoked: (uidHex, cluster) =>
        set((s) => ({
          issued: s.issued.map((x) =>
            x.uidHex === uidHex && x.cluster === cluster
              ? { ...x, revoked: true }
              : x,
          ),
        })),
      getForCluster: (cluster) =>
        get().issued.filter((x) => x.cluster === cluster),
    }),
    {
      name: ISSUED_ATTESTATION_STORAGE_KEY,
      storage: issuedAttestationStorage,
      onRehydrateStorage: () => (_state, _err) => {
        /* hydrated */
      },
    },
  ),
);