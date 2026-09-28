import { describe, expect, it } from "vitest";
import {
  isMetaAddressRecipient,
  recipientDiscoveryMessage,
} from "../attestationRecipients";

describe("attestation recipient discovery", () => {
  it("announces meta-address recipients and directs raw forms out of band", () => {
    const metaAddress = `0x${"ab".repeat(66)}`;
    const stealthAddress = `0x${"ab".repeat(20)}`;
    const precomputedHash = `0x${"ab".repeat(32)}`;

    expect(isMetaAddressRecipient(metaAddress)).toBe(true);
    expect(isMetaAddressRecipient(stealthAddress)).toBe(false);
    expect(isMetaAddressRecipient(precomputedHash)).toBe(false);
    expect(recipientDiscoveryMessage(true)).toContain("scanner");
    expect(recipientDiscoveryMessage(false)).toContain("out of band");
  });
});
