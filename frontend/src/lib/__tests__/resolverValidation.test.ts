import { describe, expect, it } from "vitest";
import { StrKey } from "@stellar/stellar-sdk";

describe("Schema Studio custom resolver validation", () => {
  it("accepts Soroban contract IDs and rejects account or arbitrary strings", () => {
    expect(StrKey.isValidContract("CAWXRGFZITZ7TJIZNDLOPJNVEMPAZDWFI22XI76FC67YF2MDRUXLBS2T")).toBe(true);
    expect(StrKey.isValidContract("GCMPINZMMQVQ7MWIJLB34F5JRAHLQQTWCP6XB5HEZR353PPPWRUWHLPU")).toBe(false);
    expect(StrKey.isValidContract("CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")).toBe(false);
  });
});
