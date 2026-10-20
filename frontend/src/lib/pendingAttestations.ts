/**
 * Recovery for attestations that are confirmed on-chain but not fully recorded
 * locally: the UID lookup timed out, or the recipient announcement failed.
 * Each pending record moves forward one step per call, so a lookup that is
 * still syncing, or an announcement that failed, is retried later instead of
 * being dropped.
 */

import type { StellarNetwork } from "./chain";

export type PendingAnnouncement = {
  /** 0x-prefixed stealth address the payment is sent to. */
  stealthAddressHex: string;
  /** 0x-prefixed ephemeral public key from the recipient's meta-address. */
  ephemeralPubKeyHex: string;
  viewTag: number;
};

export type PendingAttestation = {
  cluster: StellarNetwork;
  /** Hash of the issuance transaction. The UID is read from its AttestationCreated event. */
  txHash: string;
  issuer: string;
  schemaIdHex: string;
  schemaName: string;
  stealthAddressHashHex: string;
  isRevocable: boolean;
  createdAtSlot: number;
  /** Expiration ledger, 0 = never. */
  expirationSlot: number;
  /** 0x-prefixed UID, once the lookup has succeeded. */
  uidHex: string | null;
  /** Present when the recipient was a meta-address, so they can be notified. */
  announcement: PendingAnnouncement | null;
  /** Message from the last failed announcement; null when none is outstanding. */
  announceError: string | null;
  createdAt: number;
};

export type PendingAttestationDeps = {
  /** Resolves the UID for a transaction. Resolves null while the event is not visible yet. */
  resolveUid: (cluster: StellarNetwork, txHash: string) => Promise<Uint8Array | null>;
  /** Records the issuance locally. Called once, when the UID first resolves. */
  onResolved: (record: PendingAttestation, uid: Uint8Array) => void;
  /** Publishes the recipient announcement for a resolved attestation. */
  announce: (record: PendingAttestation, uid: Uint8Array) => Promise<void>;
};

const inFlight = new Set<string>();

export function toHex(bytes: Uint8Array): string {
  return "0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array {
  const digits = hex.startsWith("0x") ? hex.slice(2) : hex;
  return Uint8Array.from(digits.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16));
}

/**
 * V2 announcement metadata:
 * view_tag(1) || 0xB2(1) || schema_id(32) || issuer(32) || uid(32) || nonce(32) || expiry_be(4).
 * The scanner drops any other layout.
 */
export function buildAttestationAnnouncementMetadata(input: {
  viewTag: number;
  schemaId: Uint8Array;
  issuerBytes: Uint8Array;
  uid: Uint8Array;
  nonce: Uint8Array;
  expirySlot: number;
}): Uint8Array {
  const metadata = new Uint8Array(134);
  metadata[0] = input.viewTag;
  metadata[1] = 0xb2;
  metadata.set(input.schemaId, 2);
  metadata.set(input.issuerBytes, 34);
  metadata.set(input.uid, 66);
  metadata.set(input.nonce, 98);
  new DataView(metadata.buffer).setUint32(130, input.expirySlot >>> 0, false);
  return metadata;
}

/**
 * Advance one pending attestation and return the record to keep, or null once
 * nothing is left to do. A record whose UID is still missing comes back
 * unchanged. Overlapping calls for the same transaction are skipped, so the
 * issuance is recorded and announced at most once.
 */
export async function recoverPendingAttestation(
  record: PendingAttestation,
  deps: PendingAttestationDeps,
): Promise<PendingAttestation | null> {
  const key = `${record.cluster}:${record.txHash}`;
  if (inFlight.has(key)) return record;
  inFlight.add(key);
  try {
    return await advance(record, deps);
  } finally {
    inFlight.delete(key);
  }
}

async function advance(
  record: PendingAttestation,
  deps: PendingAttestationDeps,
): Promise<PendingAttestation | null> {
  let current = record;
  let uid: Uint8Array;
  if (current.uidHex) {
    uid = fromHex(current.uidHex);
  } else {
    let resolved: Uint8Array | null;
    try {
      resolved = await deps.resolveUid(current.cluster, current.txHash);
    } catch {
      // The RPC can fail transiently. Keep the record and try again later.
      return current;
    }
    if (!resolved) return current;
    uid = resolved;
    current = { ...current, uidHex: toHex(uid) };
    deps.onResolved(current, uid);
  }

  if (!current.announcement) return null;
  try {
    await deps.announce(current, uid);
    return null;
  } catch (e) {
    return {
      ...current,
      announceError: e instanceof Error ? e.message : "Announcement failed. Retry it.",
    };
  }
}
