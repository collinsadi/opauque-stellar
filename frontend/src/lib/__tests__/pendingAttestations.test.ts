import { describe, expect, it, vi } from "vitest";
import {
  buildAttestationAnnouncementMetadata,
  recoverPendingAttestation,
  type PendingAttestation,
  type PendingAttestationDeps,
} from "../pendingAttestations";

const uid = new Uint8Array(32).fill(7);

function pending(overrides: Partial<PendingAttestation> = {}): PendingAttestation {
  return {
    cluster: "testnet",
    txHash: "tx-1",
    issuer: "GCMPINZMMQVQ7MWIJLB34F5JRAHLQQTWCP6XB5HEZR353PPPWRUWHLPU",
    schemaIdHex: `0x${"11".repeat(32)}`,
    schemaName: "KYC",
    stealthAddressHashHex: `0x${"22".repeat(32)}`,
    isRevocable: true,
    createdAtSlot: 100,
    expirationSlot: 0,
    uidHex: null,
    announcement: {
      stealthAddressHex: `0x${"33".repeat(20)}`,
      ephemeralPubKeyHex: `0x${"44".repeat(33)}`,
      viewTag: 9,
    },
    announceError: null,
    createdAt: 1,
    ...overrides,
  };
}

function deps(overrides: Partial<PendingAttestationDeps> = {}) {
  return {
    resolveUid: vi.fn(async () => uid as Uint8Array | null),
    onResolved: vi.fn(),
    announce: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("buildAttestationAnnouncementMetadata", () => {
  it("lays out the V2 payload the scanner expects", () => {
    const metadata = buildAttestationAnnouncementMetadata({
      viewTag: 0xab,
      schemaId: new Uint8Array(32).fill(1),
      issuerBytes: new Uint8Array(32).fill(2),
      uid: new Uint8Array(32).fill(3),
      nonce: new Uint8Array(32).fill(4),
      expirySlot: 0x01020304,
    });

    expect(metadata.length).toBe(134);
    expect(metadata[0]).toBe(0xab);
    expect(metadata[1]).toBe(0xb2);
    expect(metadata[2]).toBe(1);
    expect(metadata[33]).toBe(1);
    expect(metadata[34]).toBe(2);
    expect(metadata[65]).toBe(2);
    expect(metadata[66]).toBe(3);
    expect(metadata[97]).toBe(3);
    expect(metadata[98]).toBe(4);
    expect(metadata[129]).toBe(4);
    expect(Array.from(metadata.slice(130))).toEqual([1, 2, 3, 4]);
  });
});

describe("recoverPendingAttestation", () => {
  it("keeps the record while the UID lookup times out, then completes recovery", async () => {
    const record = pending();
    const d = deps({
      resolveUid: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(uid),
    });

    const waiting = await recoverPendingAttestation(record, d);
    expect(waiting).toBe(record);
    expect(d.onResolved).not.toHaveBeenCalled();
    expect(d.announce).not.toHaveBeenCalled();

    const done = await recoverPendingAttestation(record, d);
    expect(done).toBeNull();
    expect(d.onResolved).toHaveBeenCalledTimes(1);
    expect(d.announce).toHaveBeenCalledTimes(1);
    expect(d.announce.mock.calls[0]?.[1]).toEqual(uid);
  });

  it("treats a failed lookup request as still pending", async () => {
    const record = pending();
    const d = deps({
      resolveUid: vi.fn().mockRejectedValueOnce(new Error("rpc timeout")),
    });

    const waiting = await recoverPendingAttestation(record, d);
    expect(waiting).toBe(record);
    expect(d.onResolved).not.toHaveBeenCalled();
  });

  it("keeps a failed announcement and retries it without resolving the UID again", async () => {
    const d = deps({
      announce: vi
        .fn()
        .mockRejectedValueOnce(new Error("relayer down"))
        .mockResolvedValueOnce(undefined),
    });

    const first = await recoverPendingAttestation(pending(), d);
    expect(first?.announceError).toBe("relayer down");
    expect(first?.uidHex).toBe(`0x${"07".repeat(32)}`);
    expect(d.onResolved).toHaveBeenCalledTimes(1);

    const second = await recoverPendingAttestation(first!, d);
    expect(second).toBeNull();
    expect(d.resolveUid).toHaveBeenCalledTimes(1);
    expect(d.onResolved).toHaveBeenCalledTimes(1);
    expect(d.announce).toHaveBeenCalledTimes(2);
  });

  it("records the issuance without announcing when the recipient is not a meta-address", async () => {
    const d = deps();

    const done = await recoverPendingAttestation(pending({ announcement: null }), d);
    expect(done).toBeNull();
    expect(d.onResolved).toHaveBeenCalledTimes(1);
    expect(d.announce).not.toHaveBeenCalled();
  });

  it("runs overlapping passes for the same attestation only once", async () => {
    const record = pending();
    const d = deps();

    const [first, second] = await Promise.all([
      recoverPendingAttestation(record, d),
      recoverPendingAttestation(record, d),
    ]);
    expect(d.resolveUid).toHaveBeenCalledTimes(1);
    expect(d.announce).toHaveBeenCalledTimes(1);
    expect(first).toBeNull();
    expect(second).toBe(record);
  });
});
