/**
 * Resolves the canonical v1 deployment manifest for Stellar networks.
 */

import {
  CONTRACT_KEYS,
  CONTRACT_ENV_SUFFIX,
  DEPLOYMENT_MANIFESTS,
  type ContractKey,
  type DeploymentManifestV1,
  type DeploymentNetwork,
  isValidStellarContractId,
} from "@deployments/index";

export {
  isValidStellarContractId,
  CONTRACT_KEYS,
  CONTRACT_ENV_SUFFIX,
};
import { getNetwork, type StellarNetwork } from "../lib/chain";

export type { ContractKey, DeploymentManifestV1, DeploymentNetwork };

const MANIFEST_NETWORKS = new Set<DeploymentNetwork>(["testnet", "mainnet"]);

export function isManifestNetwork(
  network: StellarNetwork,
): network is DeploymentNetwork {
  return MANIFEST_NETWORKS.has(network as DeploymentNetwork);
}

export function getManifestForNetwork(
  network: StellarNetwork,
): DeploymentManifestV1 | null {
  if (!isManifestNetwork(network)) return null;
  return DEPLOYMENT_MANIFESTS[network];
}

export function getActiveManifest(): DeploymentManifestV1 | null {
  return getManifestForNetwork(getNetwork());
}

function envValue(key: string): string | undefined {
  const value = (import.meta.env[key] as string | undefined)?.trim();
  return value && value.length > 0 ? value : undefined;
}

function networkEnvPrefix(network: DeploymentNetwork): string {
  return network.toUpperCase();
}

/**
 * Resolve a contract ID: network-prefixed env (override) → manifest → legacy unprefixed env (dev only).
 */
export function resolveContractId(
  network: StellarNetwork,
  key: ContractKey,
): string {
  const envSuffix = CONTRACT_ENV_SUFFIX[key];

  if (isManifestNetwork(network)) {
    const networkKey = `VITE_${networkEnvPrefix(network)}_${envSuffix}`;
    const networkValue = envValue(networkKey);
    if (networkValue) return networkValue;

    const manifestId = DEPLOYMENT_MANIFESTS[network].contracts[key]?.id;
    if (manifestId) return manifestId;
  }

  if (!import.meta.env.PROD) {
    return envValue(`VITE_${envSuffix}`) ?? "";
  }

  return "";
}

export function resolveAllContractIds(
  network: StellarNetwork,
): Record<ContractKey, string> {
  return Object.fromEntries(
    CONTRACT_KEYS.map((key) => [key, resolveContractId(network, key)]),
  ) as Record<ContractKey, string>;
}

export function assertProductionAddresses(
  network: StellarNetwork,
  addresses: Record<ContractKey, string>,
): void {
  if (!import.meta.env.PROD) return;

  const manifest = getManifestForNetwork(network);
  if (manifest && manifest.deploymentStatus !== "deployed") {
    return;
  }

  const missing = CONTRACT_KEYS.filter((key) => addresses[key].length === 0);
  if (missing.length > 0) {
    const expected = missing.map((key) => {
      if (isManifestNetwork(network)) {
        return `VITE_${networkEnvPrefix(network)}_${CONTRACT_ENV_SUFFIX[key]} or deployments/v1/${network}.json`;
      }
      return `VITE_${CONTRACT_ENV_SUFFIX[key]}`;
    });
    throw new Error(
      `[Opaque] Missing ${network} contract IDs for production build: ${expected.join(", ")}`,
    );
  }

  const invalid = CONTRACT_KEYS.filter(
    (key) => !isValidStellarContractId(addresses[key]),
  );
  if (invalid.length > 0) {
    throw new Error(
      `[Opaque] Invalid Stellar contract IDs for ${network}: ${invalid.join(", ")}`,
    );
  }

  const seen = new Map<string, ContractKey>();
  const duplicates = new Set<string>();
  for (const key of CONTRACT_KEYS) {
    const id = addresses[key];
    const firstKey = seen.get(id);
    if (firstKey !== undefined) {
      duplicates.add(`${firstKey}/${key}: ${id}`);
    } else {
      seen.set(id, key);
    }
  }

  if (duplicates.size > 0) {
    throw new Error(
      `[Opaque] Duplicate ${network} contract IDs in production build: ${Array.from(duplicates).join(", ")}`,
    );
  }
}
