import { describe, expect, it } from "vitest";
import {
  generateReputationProof,
  isReputationRootUnavailableError,
  REPUTATION_ROOT_UNAVAILABLE_MESSAGE,
} from "../reputationProver";
import type { V2DiscoveredTrait } from "../../store/schemaStore";

function traitWith(overrides: { issuer?: string; traitDataHash?: string; issuerPkX?: string }) {
  return {
    stealthAddress: "0x00",
    schemaId: "0x01",
    schemaName: "test",
    issuer: overrides.issuer ?? "0x02",
    attestationUid: "0x03",
    dataHex: "",
    nonce: "0x04",
    merkleLeafPreimage: {
      stealthPkField: "0",
      schemaIdField: "0x01",
      issuerPkX: overrides.issuerPkX ?? "0x02",
      traitDataHash: overrides.traitDataHash ?? "0x05",
      nonceField: "0x04",
    },
    txHash: "h",
    slot: 1,
    isValid: true,
    issuerAuthorized: true,
    isV2: true,
  } as V2DiscoveredTrait;
}

const noopProgress = () => {};

describe("reputationProver", () => {
  it("refuses to prove when the attestation issuer does not match its leaf preimage", async () => {
    const trait = traitWith({ issuer: "0x0a", issuerPkX: "0x0b" });
    await expect(
      generateReputationProof({} as never, trait, "", new Uint8Array(32).fill(1), "7", noopProgress),
    ).rejects.toThrow("Attestation issuer does not match");
  });

  it("refuses to prove with a placeholder trait data hash", async () => {
    const trait = traitWith({ traitDataHash: "0" });
    await expect(
      generateReputationProof({} as never, trait, "", new Uint8Array(32).fill(1), "7", noopProgress),
    ).rejects.toThrow("Trait data hash has not been derived");
  });

  it("recognizes get_latest_root Contract #2 as an unavailable root", () => {
    const err = new Error(
      "HostError: Error(Contract, #2) Event log (newest first): " +
        "topics:[fn_call, CAFVXL6A5N4FVQZ733GLUX27ETPLLINLE75ZABNLFYEKPIYZORFCBSVR, get_latest_root]",
    );

    expect(isReputationRootUnavailableError(err)).toBe(true);
    expect(REPUTATION_ROOT_UNAVAILABLE_MESSAGE).toContain("root publisher/indexer");
  });

  it("does not classify unrelated contract errors as root availability errors", () => {
    expect(isReputationRootUnavailableError("HostError: Error(Contract, #2) verify_reputation")).toBe(false);
    expect(isReputationRootUnavailableError("network timeout")).toBe(false);
  });
});
