/**
 * Horizon-backed implementation of ChainHistoryFetcher (#424).
 *
 * Fetches payment history for ghost addresses from Stellar Horizon and maps
 * the records into the ChainHistoryItem format expected by reconcileFromChain.
 * Addresses are processed in batches of 5 to avoid overwhelming the RPC
 * provider, matching the concurrency pattern in lib/horizonBatch.ts.
 */

import { getHorizonServer } from "../lib/stellar";
import { parseHorizonBalanceToStroops } from "../lib/decimalParser";
import { formatXlmFromStroops } from "../lib/i18n-format";
import type { ChainHistoryFetcher, ChainHistoryItem } from "../lib/history-reconciliation";

const CONCURRENCY = 5;
const LIMIT_PER_ADDRESS = 15;

async function fetchForAddress(
  server: ReturnType<typeof getHorizonServer>,
  address: string,
  cluster: string,
  since: number | undefined,
): Promise<ChainHistoryItem[]> {
  const response = await server
    .payments()
    .forAccount(address)
    .order("desc")
    .limit(LIMIT_PER_ADDRESS)
    .call();

  const items: ChainHistoryItem[] = [];

  for (const op of response.records) {
    if (op.type !== "payment" && op.type !== "create_account") continue;

    const timestamp = new Date(op.created_at).getTime();
    if (since !== undefined && timestamp < since) continue;

    const isPayment = op.type === "payment";
    const rawAmount = isPayment
      ? (op as { amount: string }).amount
      : (op as { starting_balance: string }).starting_balance;

    const amountBn = parseHorizonBalanceToStroops(rawAmount);
    const amountStroops = amountBn.toString();

    const isNative =
      !isPayment || (op as { asset_type: string }).asset_type === "native";

    const counterparty = isPayment
      ? (op as { from: string }).from
      : (op as { funder: string }).funder;

    const tokenSymbol = isNative
      ? "XLM"
      : ((op as { asset_code?: string }).asset_code ?? "UNKNOWN");

    const tokenAddress = isNative
      ? null
      : ((op as { asset_issuer?: string }).asset_issuer ?? null);

    items.push({
      txHash: op.transaction_hash,
      cluster,
      kind: "received",
      counterparty: counterparty ?? "",
      amountStroops,
      amount: formatXlmFromStroops(amountBn),
      tokenSymbol,
      tokenAddress,
      stealthAddress: address,
      timestamp,
      status: op.transaction_successful ? "confirmed" : "failed",
    });
  }

  return items;
}

export const fetchHorizonHistory: ChainHistoryFetcher = async ({
  cluster,
  ghostAddresses,
  since,
}) => {
  if (ghostAddresses.length === 0) return [];

  const server = getHorizonServer();
  const all: ChainHistoryItem[] = [];
  const remaining = [...ghostAddresses];

  while (remaining.length > 0) {
    const batch = remaining.splice(0, CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map((addr) => fetchForAddress(server, addr, cluster, since)),
    );
    for (const outcome of settled) {
      if (outcome.status === "fulfilled") {
        all.push(...outcome.value);
      }
      // Per-address failures are silently skipped (account may not exist on chain yet)
    }
  }

  return all;
};
