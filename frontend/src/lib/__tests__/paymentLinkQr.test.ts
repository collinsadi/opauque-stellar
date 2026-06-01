import { describe, it, expect } from "vitest";
import {
  createPaymentLink,
  decodePaymentLink,
  isValidMetaAddress,
} from "../paymentLink";

const META =
  "0x" + "ab".repeat(32);

describe("payment link QR payload", () => {
  it("encodes versioned opaque://v1 payment link", () => {
    const link = createPaymentLink(META, "testnet");
    expect(link.startsWith("opaque://v1/testnet/")).toBe(true);
    const decoded = decodePaymentLink(link);
    expect("link" in decoded).toBe(true);
    if ("link" in decoded) {
      expect(decoded.link.version).toBe(1);
      expect(decoded.link.network).toBe("testnet");
    }
  });

  it("validates meta-address checksum format", () => {
    expect(isValidMetaAddress(META)).toBe(true);
    expect(isValidMetaAddress("0xshort")).toBe(false);
  });
});
