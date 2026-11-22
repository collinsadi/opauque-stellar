import { describe, expect, it } from "vitest";
import {
  createPaymentLink,
  createWebPaymentLink,
  decodePaymentLink,
  decodePaymentLinkRequest,
  isValidMemo,
  type Network,
} from "../paymentLink";

const META = "0x02" + "a".repeat(64) + "03" + "b".repeat(64);
const NETWORK: Network = "testnet";
const ISSUER = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

describe("payment link memo length (#1100)", () => {
  it("accepts text memos up to 28 UTF-8 bytes", () => {
    expect(isValidMemo("a".repeat(27))).toBe(true);
    expect(isValidMemo("a".repeat(28))).toBe(true);
    expect(isValidMemo("é".repeat(14))).toBe(true);
  });

  it("rejects memos over 28 UTF-8 bytes", () => {
    expect(isValidMemo("a".repeat(29))).toBe(false);
    expect(isValidMemo("é".repeat(15))).toBe(false);
  });

  it("rejects an over-length memo when an opaque link is decoded", () => {
    // Encode directly so an invalid link can still be built for the test.
    const link =
      `opaque://v1/testnet/${META}?memo=${encodeURIComponent("a".repeat(29))}`;
    const result = decodePaymentLink(link);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error.type).toBe("INVALID_PARAMETER");
      expect(result.error.message).toMatch(/28 UTF-8 bytes/);
    }
  });

  it("rejects an over-length memo in a web link", () => {
    const link =
      `opaque://v1/testnet/${META}?memo=${encodeURIComponent("é".repeat(15))}`;
    const encoded = btoa(link).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const result = decodePaymentLinkRequest(
      `https://app.example/pay/${encoded}`,
      NETWORK,
    );
    expect(result?.ok).toBe(false);
    if (result && !result.ok) expect(result.error).toMatch(/28 UTF-8 bytes/);
  });

  it("does not let the encoder emit an invalid memo", () => {
    expect(() =>
      createPaymentLink(META, NETWORK, { memo: "a".repeat(29) }),
    ).toThrow(/28 UTF-8 bytes/);
  });

  it("accepts a 28-byte memo through the full decode path", () => {
    const result = decodePaymentLinkRequest(
      createPaymentLink(META, NETWORK, { memo: "a".repeat(28) }),
      NETWORK,
    );
    expect(result?.ok).toBe(true);
    if (result?.ok) expect(result.request.memo).toBe("a".repeat(28));
  });
});

describe("SendView payment link parameters (#1101)", () => {
  it("returns null for a plain address so normal handling still runs", () => {
    expect(decodePaymentLinkRequest(ISSUER, NETWORK)).toBeNull();
    expect(decodePaymentLinkRequest(META, NETWORK)).toBeNull();
  });

  it("extracts amount and memo from an opaque link", () => {
    const result = decodePaymentLinkRequest(
      createPaymentLink(META, NETWORK, { amount: "12.5", memo: "invoice-42" }),
      NETWORK,
    );
    expect(result?.ok).toBe(true);
    if (result?.ok) {
      expect(result.request.metaAddress).toBe(META);
      expect(result.request.amount).toBe("12.5");
      expect(result.request.memo).toBe("invoice-42");
    }
  });

  it("extracts every parameter from a web link", () => {
    const result = decodePaymentLinkRequest(
      createWebPaymentLink(META, NETWORK, {
        amount: "3",
        memo: "hello",
        label: "Lunch",
        expires: new Date(Date.now() + 60_000).toISOString(),
      }),
      NETWORK,
    );
    expect(result?.ok).toBe(true);
    if (result?.ok) {
      expect(result.request.amount).toBe("3");
      expect(result.request.memo).toBe("hello");
      expect(result.request.label).toBe("Lunch");
      expect(result.request.expires).toBeTruthy();
    }
  });

  it("rejects non-native assets and issuers", () => {
    const result = decodePaymentLinkRequest(
      createPaymentLink(META, NETWORK, { asset: "USDC", issuer: ISSUER }),
      NETWORK,
    );
    expect(result?.ok).toBe(false);
    if (result && !result.ok) expect(result.error).toMatch(/non-native asset/);
  });

  it("surfaces the specific network mismatch reason", () => {
    const result = decodePaymentLinkRequest(
      createPaymentLink(META, "mainnet"),
      NETWORK,
    );
    expect(result?.ok).toBe(false);
    if (result && !result.ok) expect(result.error).toMatch(/Network mismatch/);
  });

  it("surfaces the specific expiry reason", () => {
    const link = createPaymentLink(META, NETWORK, {
      expires: new Date(Date.now() - 60_000).toISOString(),
    });
    const result = decodePaymentLinkRequest(link, NETWORK);
    expect(result?.ok).toBe(false);
    if (result && !result.ok) expect(result.error).toMatch(/has expired/);
  });

  it("surfaces the specific invalid-parameter reason", () => {
    const link = `opaque://v1/testnet/${META}?amount=-5`;
    const result = decodePaymentLinkRequest(link, NETWORK);
    expect(result?.ok).toBe(false);
    if (result && !result.ok) expect(result.error).toMatch(/Invalid amount/);
  });
});
