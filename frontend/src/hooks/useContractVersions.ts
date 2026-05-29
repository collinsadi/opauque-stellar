/**
 * useContractVersions — reads version() from every deployed Soroban contract.
 *
 * Simulates a read-only call (no signature required) to the version() method.
 * Falls back to "unknown" if the contract does not expose that method yet.
 *
 * Related: Issue #84 (contract version read methods), #83 (version inspection).
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
  parseVersionFromNative,
  getVersionStatus,
  type ContractVersionInfo,
} from "../lib/contractVersion";

const CONTRACT_ENTRIES: { key: keyof typeof deployedAddresses; name: string }[] = [
  { key: "stealthRegistry", name: "Stealth Registry" },
  { key: "stealthAnnouncer", name: "Stealth Announcer" },
  { key: "groth16Verifier", name: "Groth16 Verifier" },
  { key: "reputationVerifier", name: "Reputation Verifier" },
  { key: "schemaRegistry", name: "Schema Registry" },
  { key: "attestationEngineV2", name: "Attestation Engine V2" },
];

async function readContractVersion(
  server: ReturnType<typeof getSorobanServer>,
  passphrase: string,
  sourcePublicKey: string,
  contractId: string,
): Promise<ReturnType<typeof parseVersionFromNative>> {
  if (!contractId) return null;
  try {
    const fakeAccount = new Account(sourcePublicKey, "0");
    const contract = new Contract(contractId);
    const tx = new TransactionBuilder(fakeAccount, {
      fee: BASE_FEE,
      networkPassphrase: passphrase,
    })
      .addOperation(contract.call("version"))
      .setTimeout(30)
      .build();

    const sim = await server.simulateTransaction(tx);
    if (!isSimulationSuccess(sim) || !sim.results?.[0]) return null;

    const scVal = sim.results[0];
    if (!scVal?.xdr) return null;
    const scValXdr = (scVal as { xdr: string }).xdr;
    const parsed = xdr.ScVal.fromXDR(scValXdr, "base64");
    return parseVersionFromNative(scValToNative(parsed));
  } catch {
    return null;
  }
}

export interface UseContractVersionsResult {
  versions: ContractVersionInfo[];
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useContractVersions(sourcePublicKey: string | null | undefined): UseContractVersionsResult {
  const [versions, setVersions] = useState<ContractVersionInfo[]>(() =>
    CONTRACT_ENTRIES.map((e) => ({
      contractId: (deployedAddresses as Record<string, string>)[e.key] ?? "",
      contractName: e.name,
      version: null,
      status: "unknown" as const,
    })),
  );
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!sourcePublicKey) return;
    setIsLoading(true);
    setError(null);
    try {
      const server = getSorobanServer();
      const passphrase = getNetworkPassphrase();

      const results = await Promise.allSettled(
        CONTRACT_ENTRIES.map(async (entry) => {
          const contractId = (deployedAddresses as Record<string, string>)[entry.key] ?? "";
          const version = await readContractVersion(server, passphrase, sourcePublicKey, contractId);
          return {
            contractId,
            contractName: entry.name,
            version,
            status: getVersionStatus(version),
          } satisfies ContractVersionInfo;
        }),
      );

      setVersions(
        results.map((r, i) => {
          if (r.status === "fulfilled") return r.value;
          const entry = CONTRACT_ENTRIES[i]!;
          return {
            contractId: (deployedAddresses as Record<string, string>)[entry.key] ?? "",
            contractName: entry.name,
            version: null,
            status: "unknown" as const,
          };
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to read contract versions");
    } finally {
      setIsLoading(false);
    }
  }, [sourcePublicKey]);

  useEffect(() => {
    void load();
  }, [load]);

  return { versions, isLoading, error, refresh: () => void load() };
}
