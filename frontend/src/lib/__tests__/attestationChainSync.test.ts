import { describe, expect, it } from "vitest";
import {
  isVerifiedAttestationRevocationTarget,
  selectAttestationUidForTransaction,
} from "../attestationChainUtils";

describe("selectAttestationUidForTransaction", () => {
  it("selects the on-chain UID emitted for the matching repeat issuance", () => {
    const firstUid = new Uint8Array(32).fill(1);
    const secondUid = new Uint8Array(32).fill(2);
    const events = [
      { topic: "AttestationCreated", txHash: "first-tx", data: [firstUid] },
      { topic: "AttestationCreated", txHash: "second-tx", data: [secondUid] },
    ];

    expect(selectAttestationUidForTransaction(events, "SECOND-TX")).toEqual(secondUid);
  });

  it("rejects unrelated events and malformed UIDs", () => {
    expect(
      selectAttestationUidForTransaction(
        [{ topic: "AttestationCreated", txHash: "tx", data: [new Uint8Array(31)] }],
        "tx",
      ),
    ).toBeNull();
    expect(
      selectAttestationUidForTransaction(
        [{ topic: "OtherEvent", txHash: "tx", data: [new Uint8Array(32)] }],
        "tx",
      ),
    ).toBeNull();
  });

  it("verifies a revoke target against the matching on-chain repeat issuance", () => {
    const uid1 = `0x${"01".repeat(32)}`;
    const uid2 = `0x${"02".repeat(32)}`;
    const chainRecord = {
      uidHex: uid2,
      issuer: "GISSUER",
      schemaIdHex: `0x${"03".repeat(32)}`,
      stealthAddressHashHex: `0x${"04".repeat(32)}`,
      revocationLedger: 0,
    };
    const expected = {
      uidHex: uid2,
      schemaIdHex: `0x${"03".repeat(32)}`,
      stealthAddressHashHex: `0x${"04".repeat(32)}`,
    };

    expect(isVerifiedAttestationRevocationTarget(chainRecord, expected, "GISSUER")).toBe(true);
    expect(isVerifiedAttestationRevocationTarget(chainRecord, { ...expected, uidHex: uid1 }, "GISSUER")).toBe(false);
  });
});
