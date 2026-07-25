/**
 * Root freshness verification before proof generation (#629)
 * Prevents wasting full proving cycles on stale roots that will be rejected on-chain.
 */

import { getSorobanServer } from "./stellar";
import { reputationAddresses } from "../contracts/reputationAddresses";

interface RootFreshnessCheckResult {
  isFresh: boolean;
  currentLedger: number;
  rootLedger: number;
  expiryLedgers: number;
  ledgersRemaining: number;
}

/**
 * Check if a merkle root is fresh before generating a proof.
 * Queries the reputation verifier contract for root age and expiry window.
 * Returns false if root is stale or will expire soon.
 */
export async function checkRootFreshness(
  rootHash: string,
  network: string,
): Promise<RootFreshnessCheckResult> {
  const server = getSorobanServer(network);

  const currentSeq = await server.getLatestLedger().then((l) => l.sequence);

  const getRootEntry = (await (server as any).getContractData(
    reputationAddresses.reputationVerifier,
    "merkle_root",
    rootHash,
  )) as any;

  if (!getRootEntry) {
    return {
      isFresh: false,
      currentLedger: currentSeq,
      rootLedger: 0,
      expiryLedgers: 0,
      ledgersRemaining: 0,
    };
  }

  const rootLedger = getRootEntry.ledger;
  const config = await (server as any).getContractData(
    reputationAddresses.reputationVerifier,
    "config",
  );
  const expiryLedgers = config?.root_expiry_ledgers || 17280;

  const ledgersUsed = currentSeq - rootLedger;
  const ledgersRemaining = expiryLedgers - ledgersUsed;

  return {
    isFresh: ledgersRemaining > 0,
    currentLedger: currentSeq,
    rootLedger,
    expiryLedgers,
    ledgersRemaining,
  };
}

/**
 * Warn user if root is stale or near expiry.
 * Returns true if safe to proceed with proof generation.
 */
export async function validateRootBeforeProof(
  rootHash: string,
  network: string,
  minLedgersBuffer: number = 100,
): Promise<{ safe: boolean; message: string }> {
  const check = await checkRootFreshness(rootHash, network);

  if (!check.isFresh) {
    return {
      safe: false,
      message: `Root is stale (expired ${Math.abs(check.ledgersRemaining)} ledgers ago). Refresh before proving.`,
    };
  }

  if (check.ledgersRemaining < minLedgersBuffer) {
    return {
      safe: false,
      message: `Root expires in ${check.ledgersRemaining} ledgers (~${Math.round(check.ledgersRemaining * 5 / 60)}min). Refresh first to avoid proof rejection.`,
    };
  }

  return {
    safe: true,
    message: `Root is fresh (${check.ledgersRemaining} ledgers remaining).`,
  };
}
