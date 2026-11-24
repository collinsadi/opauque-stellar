/**
 * #1079 — the Freighter adapter handles v2+ result shapes (errors are returned,
 * not thrown), maps them to typed SDK errors, and never serves a stale address.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  freighterSigner,
  MissingPeerDependencyError,
  SignerError,
  SignerRejectedError,
  type FreighterApiLike,
} from "../../src/signer/freighter";
import { stellarWalletsKitSigner } from "../../src/index";

const CTX = { networkPassphrase: "Test SDF Network ; September 2015" };
const ALICE = "GALICE";
const BOB = "GBOB";
const REJECTED = { code: -4, message: "The user rejected this request." };

/** A fake Freighter v2+ extension whose active account can be switched. */
function fakeFreighter(state: { address: string; allowed?: boolean; rejectSign?: boolean; rejectAccess?: boolean }) {
  const api: FreighterApiLike = {
    isAllowed: vi.fn(async () => ({ isAllowed: state.allowed ?? true })),
    requestAccess: vi.fn(async () =>
      state.rejectAccess ? { address: "", error: REJECTED } : ((state.allowed = true), { address: state.address }),
    ),
    getAddress: vi.fn(async () => ({ address: state.address })),
    signTransaction: vi.fn(async (xdr: string) =>
      state.rejectSign
        ? { signedTxXdr: "", signerAddress: "", error: REJECTED }
        : { signedTxXdr: `signed(${xdr})`, signerAddress: state.address },
    ),
  };
  return api;
}

afterEach(() => {
  vi.doUnmock("@stellar/freighter-api");
  vi.resetModules();
});

describe("freighterSigner (#1079)", () => {
  it("approve: returns the address and the signed XDR", async () => {
    const api = fakeFreighter({ address: ALICE });
    const signer = freighterSigner({ api });
    expect(await signer.publicKey()).toBe(ALICE);
    expect(await signer.signTransaction("xdr", CTX)).toBe("signed(xdr)");
    expect(api.signTransaction).toHaveBeenCalledWith("xdr", { networkPassphrase: CTX.networkPassphrase });
  });

  it("prompts for access when the site is not yet allowed", async () => {
    const api = fakeFreighter({ address: ALICE, allowed: false });
    expect(await freighterSigner({ api }).publicKey()).toBe(ALICE);
    expect(api.requestAccess).toHaveBeenCalledOnce();
  });

  it("reject (sign): a returned error becomes SignerRejectedError, never an undefined XDR", async () => {
    const signer = freighterSigner({ api: fakeFreighter({ address: ALICE, rejectSign: true }) });
    await signer.publicKey();
    const err = await signer.signTransaction("xdr", CTX).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SignerRejectedError);
    expect(err).toMatchObject({ code: "SIGNER", reason: "rejected" });
  });

  it("reject (connect): a declined access request becomes SignerRejectedError", async () => {
    const signer = freighterSigner({ api: fakeFreighter({ address: ALICE, allowed: false, rejectAccess: true }) });
    await expect(signer.publicKey()).rejects.toBeInstanceOf(SignerRejectedError);
  });

  it("maps a thrown or non-rejection error to SignerError", async () => {
    const api = fakeFreighter({ address: ALICE });
    api.signTransaction = vi.fn(async () => ({ signedTxXdr: "", signerAddress: "", error: { code: -1, message: "internal" } }));
    const err = await freighterSigner({ api }).signTransaction("xdr", CTX).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SignerError);
    expect(err).not.toBeInstanceOf(SignerRejectedError);
    expect((err as SignerError).reason).toBe("failed");

    api.signTransaction = vi.fn(async () => {
      throw new Error("extension crashed");
    });
    await expect(freighterSigner({ api }).signTransaction("xdr", CTX)).rejects.toBeInstanceOf(SignerError);
  });

  it("account switch: publicKey follows the active account", async () => {
    const state = { address: ALICE };
    const signer = freighterSigner({ api: fakeFreighter(state) });
    expect(await signer.publicKey()).toBe(ALICE);
    state.address = BOB;
    expect(await signer.publicKey()).toBe(BOB);
    expect(await signer.signTransaction("xdr", CTX)).toBe("signed(xdr)");
  });

  it("account switch: signing with a different account than the tx was built for fails", async () => {
    const state = { address: ALICE };
    const signer = freighterSigner({ api: fakeFreighter(state) });
    await signer.publicKey(); // tx built for ALICE
    state.address = BOB; // user switches account in the extension
    const err = await signer.signTransaction("xdr", CTX).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SignerError);
    expect((err as SignerError).reason).toBe("account-changed");
  });

  it("fails with MissingPeerDependencyError when @stellar/freighter-api is not installed", async () => {
    vi.doMock("@stellar/freighter-api", () => {
      throw new Error("Cannot find package '@stellar/freighter-api'");
    });
    vi.resetModules();
    const mod = await import("../../src/signer/freighter");
    const errors = await import("../../src/errors/index");
    const err = await Promise.resolve(mod.freighterSigner().publicKey()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(errors.MissingPeerDependencyError);
    expect(err).toMatchObject({ dependency: "@stellar/freighter-api" });
    expect(MissingPeerDependencyError).toBeDefined();
  });
});

describe("stellarWalletsKitSigner (#1079)", () => {
  it("maps a returned rejection to SignerRejectedError and follows account switches", async () => {
    const state = { address: ALICE };
    const signer = stellarWalletsKitSigner({
      requestAccess: async () => ({ address: state.address }),
      getAddress: async () => ({ address: state.address }),
      signTransaction: async () => ({ signedTxXdr: "", error: REJECTED }),
    });
    expect(await signer.publicKey()).toBe(ALICE);
    state.address = BOB;
    expect(await signer.publicKey()).toBe(BOB);
    await expect(signer.signTransaction("xdr", CTX)).rejects.toBeInstanceOf(SignerRejectedError);
  });
});
