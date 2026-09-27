import { describe, it, expect } from "vitest";
import {
  createPaymentLink,
  createWebPaymentLink,
  decodePaymentLink,
  decodeWebPaymentLink,
  isOpaquePaymentLink,
  isWebPaymentLink,
  type Network,
} from "../paymentLink";

// A valid 66-byte (132 hex char) stealth meta-address for testing.
const META =
  "0x02" +
  "a".repeat(64) +
  "03" +
  "b".repeat(64);

const NETWORK: Network = "testnet";

describe("Payment link web round-trip", () => {
  it("encodes an opaque:// URI and round-trips through decode", () => {
    const opaqueUri = createPaymentLink(META, NETWORK);
    expect(opaqueUri).toMatch(/^opaque:\/\/v1\//);
    expect(isOpaquePaymentLink(opaqueUri)).toBe(true);

    const result = decodePaymentLink(opaqueUri);
    expect("link" in result).toBe(true);
    if ("link" in result) {
      expect(result.link.metaAddress).toBe(META);
      expect(result.link.network).toBe(NETWORK);
    }
  });

  it("encodes a web (https) link and round-trips through decode", () => {
    const webLink = createWebPaymentLink(META, NETWORK, { amount: "10" });
    expect(webLink).toContain("/pay/");
    expect(isWebPaymentLink(webLink)).toBe(true);

    const result = decodeWebPaymentLink(webLink);
    expect(result).not.toBeNull();
    expect(result && "link" in result).toBe(true);
    if (result && "link" in result) {
      expect(result.link.metaAddress).toBe(META);
      expect(result.link.network).toBe(NETWORK);
      expect(result.link.params.amount).toBe("10");
    }
  });

  it("web link and opaque link decode to the same payload", () => {
    const params = { amount: "5.5", memo: "hello" };
    const opaqueUri = createPaymentLink(META, NETWORK, params);
    const webLink = createWebPaymentLink(META, NETWORK, params);

    const opaqueResult = decodePaymentLink(opaqueUri);
    const webResult = decodeWebPaymentLink(webLink);

    expect("link" in opaqueResult).toBe(true);
    expect(webResult && "link" in webResult).toBe(true);
    if ("link" in opaqueResult && webResult && "link" in webResult) {
      expect(webResult.link.metaAddress).toBe(opaqueResult.link.metaAddress);
      expect(webResult.link.network).toBe(opaqueResult.link.network);
      expect(webResult.link.params.amount).toBe(opaqueResult.link.params.amount);
      expect(webResult.link.params.memo).toBe(opaqueResult.link.params.memo);
    }
  });

  it("returns null for non-web-link URLs", () => {
    expect(decodeWebPaymentLink("https://example.com/foo")).toBeNull();
    expect(decodeWebPaymentLink("not-a-url")).toBeNull();
  });

  it("rejects a web link with a network mismatch", () => {
    const webLink = createWebPaymentLink(META, "mainnet");
    const result = decodeWebPaymentLink(webLink, "testnet");
    expect(result).not.toBeNull();
    expect(result && "error" in result).toBe(true);
    if (result && "error" in result) {
      expect(result.error.type).toBe("NETWORK_MISMATCH");
    }
  });
});
