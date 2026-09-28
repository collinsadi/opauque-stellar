import { describe, expect, it } from "vitest";
import { isValidAdminAddress } from "../adminInputValidation";

describe("admin address validation", () => {
  it("accepts checksummed Stellar account and contract StrKeys", () => {
    expect(isValidAdminAddress("GCMPINZMMQVQ7MWIJLB34F5JRAHLQQTWCP6XB5HEZR353PPPWRUWHLPU")).toBe(true);
    expect(isValidAdminAddress("CAWXRGFZITZ7TJIZNDLOPJNVEMPAZDWFI22XI76FC67YF2MDRUXLBS2T")).toBe(true);
  });

  it("rejects malformed StrKeys and arbitrary text", () => {
    expect(isValidAdminAddress("G000000000000000000000000000000000000000000000000000000000")).toBe(false);
    expect(isValidAdminAddress("not-an-address")).toBe(false);
  });
});
