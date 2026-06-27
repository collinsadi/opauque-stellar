import { describe, it, expect } from "vitest";
import { KeyRotationManager } from "../services/keyRotationManager";
import { webcrypto } from "node:crypto";

if (!globalThis.crypto) {
  (globalThis as { crypto?: Crypto }).crypto = webcrypto as unknown as Crypto;
}

describe("KeyRotationManager", () => {
  it("should generate a new meta address and distinguish it", async () => {
    const newAddress = await KeyRotationManager.generateNewMetaAddress("OLD_ADDR");

    expect(newAddress).toBeDefined();
    // Real Stellar StrKey public keys start with "G" and are 56 characters
    expect(newAddress).toMatch(/^G[A-Z2-7]{55}$/);
    expect(newAddress).not.toEqual("OLD_ADDR");
  });

  it("should return the correct sequence of migration steps", () => {
    const steps = KeyRotationManager.getMigrationSteps();
    expect(steps.length).toBe(5);
    expect(steps[0].title).toBe("Generate new address");
  });
});
