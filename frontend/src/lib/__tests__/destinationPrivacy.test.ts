import { describe, expect, it } from "vitest";
import { evaluateDestinationPrivacy } from "../destinationPrivacy";

const MAIN = "GA5XIGA5C7QTPTWXQHY6MCJRMTRZDOSHR6EFIBNDQTCQHG262N4GGKTM";
const FRESH = "GCMPINZMMQVQ7MWIJLB34F5JRAHLQQTWCP6XB5HEZR353PPPWRUWHLPU";
const OTHER = "GBBD47UZQ2KSYFIUDGFZQ6JSVXHQE4NVJYSDLDBFZ6A7QQMH3LJJMXR4";

describe("evaluateDestinationPrivacy", () => {
  it("shows no verdict for an empty destination", () => {
    expect(
      evaluateDestinationPrivacy({
        destination: "",
        mainWalletAddress: MAIN,
        otherDestinations: [],
      }),
    ).toEqual({ kind: "none" });
  });

  it("shows no verdict for whitespace-only input", () => {
    expect(
      evaluateDestinationPrivacy({
        destination: "   ",
        mainWalletAddress: undefined,
        otherDestinations: [],
      }).kind,
    ).toBe("none");
  });

  it("shows no verdict for an invalid address, even when it matches the wallet", () => {
    expect(
      evaluateDestinationPrivacy({
        destination: "not-a-stellar-address",
        mainWalletAddress: "not-a-stellar-address",
        otherDestinations: [],
      }).kind,
    ).toBe("none");
  });

  it("flags the connected wallet as the destination", () => {
    expect(
      evaluateDestinationPrivacy({
        destination: MAIN,
        mainWalletAddress: MAIN,
        otherDestinations: [],
      }),
    ).toEqual({ kind: "same-as-main" });
  });

  it("flags a destination reused across claims", () => {
    expect(
      evaluateDestinationPrivacy({
        destination: FRESH,
        mainWalletAddress: MAIN,
        otherDestinations: [OTHER, FRESH],
      }),
    ).toEqual({ kind: "reused" });
  });

  it("ignores surrounding whitespace when comparing against other claims", () => {
    expect(
      evaluateDestinationPrivacy({
        destination: `  ${FRESH}  `,
        mainWalletAddress: MAIN,
        otherDestinations: [FRESH],
      }).kind,
    ).toBe("reused");
  });

  it("gives a positive verdict for a fresh destination", () => {
    expect(
      evaluateDestinationPrivacy({
        destination: FRESH,
        mainWalletAddress: MAIN,
        otherDestinations: [OTHER, ""],
      }),
    ).toEqual({ kind: "fresh" });
  });

  it("gives a positive verdict when no wallet is connected and nothing is reused", () => {
    expect(
      evaluateDestinationPrivacy({
        destination: FRESH,
        mainWalletAddress: undefined,
        otherDestinations: [],
      }).kind,
    ).toBe("fresh");
  });

  it("prefers the wallet warning over reuse when both apply", () => {
    expect(
      evaluateDestinationPrivacy({
        destination: MAIN,
        mainWalletAddress: MAIN,
        otherDestinations: [MAIN],
      }).kind,
    ).toBe("same-as-main");
  });
});
