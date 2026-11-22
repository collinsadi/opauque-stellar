/**
 * Max-send math for private payments (issue #1098).
 *
 * A send is two transactions: a classic transfer and a Soroban announcement.
 * The wallet must keep its real minimum balance (base reserve + subentries,
 * net of sponsorships) AND both fees, otherwise the transfer can land while
 * the announcement fails for lack of funds.
 */

import {
  BASE_FEE,
  Contract,
  TransactionBuilder,
  nativeToScVal,
} from "@stellar/stellar-sdk";
import { getNetworkPassphrase } from "./chain";
import { parseHorizonBalanceToStroops } from "./decimalParser";
import { SCHEME_ID_SECP256K1 } from "./contracts";
import { deployedAddresses } from "../contracts/deployedAddresses";
import {
  bytesToScVal,
  getHorizonServer,
  getLatestLedgerRules,
  getSorobanServer,
  minimumBalanceForAccount,
  u64ToScVal,
} from "./stellar";

type HorizonAccount = Awaited<
  ReturnType<ReturnType<typeof getHorizonServer>["loadAccount"]>
>;

/** Headroom used when the announcement cannot be simulated right now. */
export const FALLBACK_ANNOUNCEMENT_FEE_STROOPS = 5_000_000n + BigInt(BASE_FEE);

export type MaxSendableQuote = {
  balanceStroops: bigint;
  minimumBalanceStroops: bigint;
  transferFeeStroops: bigint;
  announcementFeeStroops: bigint;
  maxSendableStroops: bigint;
};

/**
 * Pure reserve + fee math. Kept separate so the subentry/sponsorship cases
 * can be tested without a network.
 */
export function computeMaxSendableStroops(input: {
  balanceStroops: bigint;
  minimumBalanceStroops: bigint;
  transferFeeStroops: bigint;
  announcementFeeStroops: bigint;
}): bigint {
  const retained =
    input.minimumBalanceStroops +
    input.transferFeeStroops +
    input.announcementFeeStroops;
  return input.balanceStroops > retained
    ? input.balanceStroops - retained
    : 0n;
}

/**
 * Simulate a representative announcement to learn its real resource fee.
 * Argument sizes match a scheme-1 personal announcement, so the simulated
 * resource usage matches the one the send will actually pay.
 */
export async function simulateAnnouncementFeeStroops(opts: {
  sourceAccount: HorizonAccount;
  sourcePublicKey: string;
}): Promise<bigint> {
  try {
    const ephemeralPubKey = new Uint8Array(33);
    ephemeralPubKey[0] = 0x02;
    const announcement = new Contract(
      deployedAddresses.stealthAnnouncer,
    ).call(
      "announce",
      nativeToScVal(opts.sourcePublicKey, { type: "address" }),
      u64ToScVal(SCHEME_ID_SECP256K1),
      bytesToScVal(new Uint8Array(20)),
      bytesToScVal(ephemeralPubKey),
      bytesToScVal(new Uint8Array(1)),
    );
    const tx = new TransactionBuilder(opts.sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: getNetworkPassphrase(),
    })
      .addOperation(announcement)
      .setTimeout(180)
      .build();
    const prepared = await getSorobanServer().prepareTransaction(tx);
    return BigInt(prepared.fee ?? BASE_FEE);
  } catch {
    // A Max quote must never be blocked by a transient RPC failure; fall back
    // to a conservative fee rather than silently using a single classic fee.
    return FALLBACK_ANNOUNCEMENT_FEE_STROOPS;
  }
}

/**
 * Quote the maximum XLM a source account can send while still retaining its
 * real minimum balance and enough to publish the announcement.
 */
export async function getMaxSendableQuote(opts: {
  sourcePublicKey: string;
  /** Overridable for callers/tests that already simulated the announcement. */
  announcementFeeStroops?: bigint;
}): Promise<MaxSendableQuote> {
  const [sourceAccount, ledgerRules] = await Promise.all([
    getHorizonServer().loadAccount(opts.sourcePublicKey),
    getLatestLedgerRules().catch(() => ({
      baseFeeStroops: BigInt(BASE_FEE),
      baseReserveStroops: 5_000_000n,
    })),
  ]);
  const native = sourceAccount.balances.find((b) => b.asset_type === "native");
  const balanceStroops = parseHorizonBalanceToStroops(
    (native as { balance?: string } | undefined)?.balance,
  );
  const minimumBalanceStroops = minimumBalanceForAccount(
    sourceAccount,
    ledgerRules.baseReserveStroops,
  );
  const transferFeeStroops = ledgerRules.baseFeeStroops;
  const announcementFeeStroops =
    opts.announcementFeeStroops ??
    (await simulateAnnouncementFeeStroops({
      sourceAccount,
      sourcePublicKey: opts.sourcePublicKey,
    }));
  const maxSendableStroops = computeMaxSendableStroops({
    balanceStroops,
    minimumBalanceStroops,
    transferFeeStroops,
    announcementFeeStroops,
  });
  return {
    balanceStroops,
    minimumBalanceStroops,
    transferFeeStroops,
    announcementFeeStroops,
    maxSendableStroops,
  };
}
