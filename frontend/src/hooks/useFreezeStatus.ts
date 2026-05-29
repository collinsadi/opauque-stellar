/**
 * useFreezeStatus — polls is_frozen() and last_root_update() from the
 * reputation verifier and Groth16 contracts.
 *
 * Falls back to "unknown" gracefully when the contract has not yet
 * implemented the freeze API.
 *
 * Related: Issue #85 (emergency freeze policy for reputation roots).
 */

import { useState, useEffect, useCallback } from "react";
import {
  Account,
  Contract,
  TransactionBuilder,
  BASE_FEE,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { getSorobanServer } from "../lib/stellar";
import { getNetworkPassphrase } from "../lib/chain";
import { isSimulationSuccess } from "../lib/sorobanErrors";
import { deployedAddresses } from "../contracts/deployedAddresses";
import {
  computeFreezeStatus,
  type FreezeInfo,
  type FreezeStatus,
} from "../lib/freezePolicy";

const POLL_INTERVAL_MS = 60_000;

async function simulateRead(
  server: ReturnType<typeof getSorobanServer>,
  passphrase: string,
  sourcePublicKey: string,
  contractId: string,
  method: string,
): Promise<unknown> {
  if (!contractId) return null;
  try {
    const fakeAccount = new Account(sourcePublicKey, "0");
    const contract = new Contract(contractId);
    const tx = new TransactionBuilder(fakeAccount, {
      fee: BASE_FEE,
      networkPassphrase: passphrase,
    })
      .addOperation(contract.call(method))
      .setTimeout(30)
      .build();

    const sim = await server.simulateTransaction(tx);
    if (!isSimulationSuccess(sim) || !sim.results?.[0]) return null;
    const raw = (sim.results[0] as { xdr?: string }).xdr;
    if (!raw) return null;
    return scValToNative(xdr.ScVal.fromXDR(raw, "base64"));
  } catch {
    return null;
  }
}

async function readFreezeInfo(
  server: ReturnType<typeof getSorobanServer>,
  passphrase: string,
  sourcePublicKey: string,
  contractId: string,
): Promise<{ isFrozen: boolean | null; lastRootUpdateLedger: number | null }> {
  const [frozenRaw, lastUpdateRaw] = await Promise.all([
    simulateRead(server, passphrase, sourcePublicKey, contractId, "is_frozen"),
    simulateRead(server, passphrase, sourcePublicKey, contractId, "last_root_update"),
  ]);

  const isFrozen = typeof frozenRaw === "boolean" ? frozenRaw : null;
  const lastRootUpdateLedger =
    typeof lastUpdateRaw === "number"
      ? lastUpdateRaw
      : typeof lastUpdateRaw === "bigint"
        ? Number(lastUpdateRaw)
        : null;

  return { isFrozen, lastRootUpdateLedger };
}

export interface UseFreezeStatusResult {
  status: FreezeStatus;
  info: FreezeInfo;
  isLoading: boolean;
  refresh: () => void;
}

export function useFreezeStatus(sourcePublicKey: string | null | undefined): UseFreezeStatusResult {
  const [status, setStatus] = useState<FreezeStatus>("unknown");
  const [info, setInfo] = useState<FreezeInfo>({ status: "unknown" });
  const [isLoading, setIsLoading] = useState(false);

  const load = useCallback(async () => {
    if (!sourcePublicKey) return;
    setIsLoading(true);
    try {
      const server = getSorobanServer();
      const passphrase = getNetworkPassphrase();

      const [reputationResult, currentLedger] = await Promise.all([
        readFreezeInfo(
          server,
          passphrase,
          sourcePublicKey,
          deployedAddresses.reputationVerifier,
        ),
        (async () => {
          try {
            const latest = await server.getLatestLedger();
            return latest.sequence;
          } catch {
            return undefined;
          }
        })(),
      ]);

      if (reputationResult.isFrozen === null) {
        setStatus("unknown");
        setInfo({ status: "unknown" });
        return;
      }

      const computed = computeFreezeStatus({
        isFrozen: reputationResult.isFrozen,
        lastRootUpdateLedger: reputationResult.lastRootUpdateLedger ?? undefined,
        currentLedger,
      });

      const next: FreezeInfo = {
        status: computed,
        lastRootUpdateLedger: reputationResult.lastRootUpdateLedger ?? undefined,
        currentLedger,
      };

      setStatus(computed);
      setInfo(next);
    } catch {
      setStatus("unknown");
      setInfo({ status: "unknown" });
    } finally {
      setIsLoading(false);
    }
  }, [sourcePublicKey]);

  useEffect(() => {
    void load();
    if (!sourcePublicKey) return;
    const timer = setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [load, sourcePublicKey]);

  return { status, info, isLoading, refresh: () => void load() };
}
