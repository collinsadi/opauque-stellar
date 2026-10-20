/**
 * Moves pending attestations toward completion: resolves the UID from chain and
 * publishes the recipient announcement. The issuance flow calls
 * advancePendingAttestation right away, and the hook re-runs it on a timer
 * while a wallet is connected, so a lookup that was still syncing is picked up
 * later without the user having to act.
 */

import { useEffect } from "react";
import { useIssuedAttestationStore } from "../store/issuedAttestationStore";
import { usePendingAttestationStore } from "../store/pendingAttestationStore";
import type { StellarNetwork } from "../lib/chain";
import { fetchAttestationUidForTransaction } from "../lib/chainSync";
import { announceStealthTransfer, SCHEME_ID_SECP256K1 } from "../lib/contracts";
import { hexToBytes } from "../lib/programs";
import { addressToAuthorityBytes } from "../lib/schemaEncoding";
import type { SignTxFn } from "../lib/stellar";
import {
  buildAttestationAnnouncementMetadata,
  recoverPendingAttestation,
  toHex,
  type PendingAttestation,
  type PendingAttestationDeps,
} from "../lib/pendingAttestations";

const RECOVERY_INTERVAL_MS = 30_000;
const UID_ATTEMPTS = 8;
const UID_RETRY_DELAY_MS = 750;

/** The AttestationCreated event can take a few ledgers to appear, so try a few times per pass. */
async function resolveAttestationUid(cluster: StellarNetwork, txHash: string): Promise<Uint8Array | null> {
  for (let attempt = 0; attempt < UID_ATTEMPTS; attempt++) {
    const uid = await fetchAttestationUidForTransaction(cluster, txHash);
    if (uid) return uid;
    if (attempt < UID_ATTEMPTS - 1) {
      await new Promise((resolve) => setTimeout(resolve, UID_RETRY_DELAY_MS));
    }
  }
  return null;
}

function recoveryDeps(signTransaction: SignTxFn): PendingAttestationDeps {
  return {
    resolveUid: resolveAttestationUid,
    onResolved: (record, uid) => {
      useIssuedAttestationStore.getState().addIssued({
        cluster: record.cluster,
        uidHex: toHex(uid),
        schemaIdHex: record.schemaIdHex,
        schemaName: record.schemaName,
        stealthAddressHashHex: record.stealthAddressHashHex,
        createdAtSlot: record.createdAtSlot,
        expirationSlot: record.expirationSlot,
        isRevocable: record.isRevocable,
        revoked: false,
        txHash: record.txHash,
      });
    },
    announce: async (record, uid) => {
      const { announcement } = record;
      if (!announcement) return;
      const metadata = buildAttestationAnnouncementMetadata({
        viewTag: announcement.viewTag,
        schemaId: hexToBytes(record.schemaIdHex),
        issuerBytes: addressToAuthorityBytes(record.issuer),
        uid,
        nonce: crypto.getRandomValues(new Uint8Array(32)),
        expirySlot: record.expirationSlot,
      });
      await announceStealthTransfer({
        sourcePublicKey: record.issuer,
        schemeId: SCHEME_ID_SECP256K1,
        stealthAddress: hexToBytes(announcement.stealthAddressHex),
        ephemeralPubKey: hexToBytes(announcement.ephemeralPubKeyHex),
        metadata,
        signTransaction,
      });
    },
  };
}

/**
 * Move one pending attestation forward and store the outcome. Returns the
 * record that is still outstanding, or null once it is fully recorded.
 */
export async function advancePendingAttestation(
  record: PendingAttestation,
  signTransaction: SignTxFn,
): Promise<PendingAttestation | null> {
  const next = await recoverPendingAttestation(record, recoveryDeps(signTransaction));
  const store = usePendingAttestationStore.getState();
  if (next) store.upsert(next);
  else store.remove(record.cluster, record.txHash);
  return next;
}

/** Keeps the connected issuer's pending attestations moving. */
export function usePendingAttestationRecovery(
  cluster: StellarNetwork,
  publicKey: string | null,
  signTransaction: SignTxFn | null,
): void {
  useEffect(() => {
    if (!publicKey || !signTransaction) return;
    const run = async () => {
      const records = usePendingAttestationStore
        .getState()
        .getForCluster(cluster)
        .filter((record) => record.issuer === publicKey);
      for (const record of records) {
        await advancePendingAttestation(record, signTransaction);
      }
    };
    void run();
    const timer = setInterval(() => void run(), RECOVERY_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [cluster, publicKey, signTransaction]);
}
