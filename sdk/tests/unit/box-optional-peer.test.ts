/**
 * #1078 — `tweetnacl` is an optional peer: the box module must import without it,
 * the box functions keep their async API, and a missing peer is a typed error.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import nacl from "tweetnacl";

afterEach(() => {
  vi.doUnmock("tweetnacl");
  vi.resetModules();
});

describe("relayer box without tweetnacl (#1078)", () => {
  it("imports, then fails each box function with MissingPeerDependencyError", async () => {
    vi.doMock("tweetnacl", () => {
      throw new Error("Cannot find package 'tweetnacl'");
    });
    vi.resetModules();
    const box = await import("../../src/relayer-protocol/box");
    const { MissingPeerDependencyError } = await import("../../src/errors/index");

    for (const call of [
      () => box.generateX25519Keypair(),
      () => box.sealBox(new Uint8Array([1]), new Uint8Array(32)),
      () => box.openBox("AAAA", new Uint8Array(32)),
    ]) {
      const err = await call().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MissingPeerDependencyError);
      expect(err).toMatchObject({ code: "MISSING_PEER_DEPENDENCY", dependency: "tweetnacl" });
    }
  });
});

describe("relayer box API (#1078)", () => {
  it("keeps the async signatures", async () => {
    const box = await import("../../src/relayer-protocol/box");
    const kp = box.generateX25519Keypair();
    expect(kp).toBeInstanceOf(Promise);
    const { publicKey, secretKey } = await kp;
    const sealed = box.sealBox(new Uint8Array([1, 2, 3]), publicKey);
    expect(sealed).toBeInstanceOf(Promise);
    expect(Array.from(await box.openBox(await sealed, secretKey))).toEqual([1, 2, 3]);
  });

  it("createNaclBox gives synchronous functions with the same wire format", async () => {
    const box = await import("../../src/relayer-protocol/box");
    const sync = box.createNaclBox(nacl);
    const recipient = sync.generateX25519Keypair(new Uint8Array(32).fill(9));
    const fromSync = sync.sealBox(new Uint8Array([4, 5]), recipient.publicKey);
    expect(typeof fromSync).toBe("string");
    // Sealed synchronously, opened through the async API — and vice versa.
    expect(Array.from(await box.openBox(fromSync, recipient.secretKey))).toEqual([4, 5]);
    const fromAsync = await box.sealBox(new Uint8Array([6]), recipient.publicKey);
    expect(Array.from(sync.openBox(fromAsync, recipient.secretKey))).toEqual([6]);
  });
});
