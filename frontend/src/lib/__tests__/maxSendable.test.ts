import { beforeEach, describe, expect, it, vi } from "vitest";

const horizon = vi.hoisted(() => ({
  account: {} as Record<string, unknown>,
}));
const ledger = vi.hoisted(() => ({
  baseFeeStroops: 100n,
  baseReserveStroops: 5_000_000n,
}));

vi.mock("../chain", () => ({
  getHorizonUrls: () => ["https://horizon.test"],
  getRpcUrls: () => ["https://rpc.test"],
  getNetworkPassphrase: () => "Test SDF Network ; September 2015",
  getNetwork: () => "testnet",
}));
vi.mock("../monitoring", () => ({ recordContractCall: vi.fn(), recordRpcError: vi.fn() }));
vi.mock("../contracts", () => ({ SCHEME_ID_SECP256K1: 1n }));
vi.mock("../../contracts/deployedAddresses", () => ({
  deployedAddresses: { stealthAnnouncer: "C".repeat(56) },
}));

vi.mock("../stellar", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../stellar")>();
  return {
    ...actual,
    getHorizonServer: () => ({
      loadAccount: async () => horizon.account,
    }),
    getLatestLedgerRules: async () => ({ ...ledger }),
    getSorobanServer: () => ({ prepareTransaction: vi.fn() }),
  };
});

import {
  computeMaxSendableStroops,
  getMaxSendableQuote,
  FALLBACK_ANNOUNCEMENT_FEE_STROOPS,
} from "../maxSendable";
import { minimumBalanceForAccount } from "../stellar";

function account(overrides: Record<string, unknown> = {}) {
  return {
    balances: [{ asset_type: "native", balance: "100.0000000" }],
    ...overrides,
  };
}

beforeEach(() => {
  horizon.account = account();
  ledger.baseFeeStroops = 100n;
  ledger.baseReserveStroops = 5_000_000n;
});

describe("minimumBalanceForAccount (#1098)", () => {
  it("keeps two base reserves for an account with no subentries", () => {
    expect(minimumBalanceForAccount(account() as never, 5_000_000n)).toBe(
      10_000_000n,
    );
  });

  it("adds one base reserve per subentry", () => {
    expect(
      minimumBalanceForAccount(
        account({ subentry_count: 1 }) as never,
        5_000_000n,
      ),
    ).toBe(15_000_000n);
    expect(
      minimumBalanceForAccount(
        account({ subentry_count: 3 }) as never,
        5_000_000n,
      ),
    ).toBe(25_000_000n);
  });

  it("nets sponsorships and clamps at zero", () => {
    expect(
      minimumBalanceForAccount(
        account({ subentry_count: 2, num_sponsoring: 1, num_sponsored: 4 }) as never,
        5_000_000n,
      ),
    ).toBe(5_000_000n);
    expect(
      minimumBalanceForAccount(
        account({ num_sponsored: 5 }) as never,
        5_000_000n,
      ),
    ).toBe(0n);
  });
});

describe("Max send math (#1098)", () => {
  it("retains the real reserve plus both transaction fees", () => {
    expect(
      computeMaxSendableStroops({
        balanceStroops: 100_000_000n,
        minimumBalanceStroops: 10_000_000n,
        transferFeeStroops: 100n,
        announcementFeeStroops: 7_000n,
      }),
    ).toBe(89_992_900n);
  });

  it("clamps to zero when the balance cannot cover the retained amount", () => {
    expect(
      computeMaxSendableStroops({
        balanceStroops: 10_000n,
        minimumBalanceStroops: 10_000_000n,
        transferFeeStroops: 100n,
        announcementFeeStroops: 7_000n,
      }),
    ).toBe(0n);
  });

  it.each([
    [0, 10_000_000n],
    [1, 15_000_000n],
    [4, 30_000_000n],
  ])("quotes Max for an account with %i subentries", async (subentries, reserve) => {
    horizon.account = account({ subentry_count: subentries });
    const quote = await getMaxSendableQuote({
      sourcePublicKey: "GSENDER",
      announcementFeeStroops: 8_000n,
    });

    expect(quote.minimumBalanceStroops).toBe(reserve);
    expect(quote.transferFeeStroops).toBe(100n);
    expect(quote.announcementFeeStroops).toBe(8_000n);
    expect(quote.maxSendableStroops).toBe(
      1_000_000_000n - reserve - 100n - 8_000n,
    );
  });

  it("uses the ledger-provided reserve and fee", async () => {
    ledger.baseReserveStroops = 2_000_000n;
    ledger.baseFeeStroops = 250n;
    const quote = await getMaxSendableQuote({
      sourcePublicKey: "GSENDER",
      announcementFeeStroops: 500n,
    });
    expect(quote.minimumBalanceStroops).toBe(4_000_000n);
    expect(quote.maxSendableStroops).toBe(995_999_250n);
  });

  it("has a conservative fallback fee for un-simulatable announcements", () => {
    expect(FALLBACK_ANNOUNCEMENT_FEE_STROOPS).toBeGreaterThan(100n);
  });
});
