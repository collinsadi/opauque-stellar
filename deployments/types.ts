/**
 * Typed Stellar deployment manifest (v1).
 * Canonical source: deployments/v1/<network>.json
 */

export type DeploymentNetwork = "testnet" | "mainnet";

export type DeploymentStatus = "template" | "deployed" | "not_deployed";

export type ContractKey =
  | "stealthRegistry"
  | "stealthAnnouncer"
  | "groth16Verifier"
  | "reputationVerifier"
  | "schemaRegistry"
  | "attestationEngineV2"
  | "poolVerifier"
  | "privacyPool"
  | "relayerRegistry"
  | "multisigAdmin";

/** Contracts a manifest may omit until they are deployed (`multisig-admin` is not yet). */
export type OptionalContractKey = "multisigAdmin";

export type ContractRecord = {
  /** Contract ID, or null/"" until deployed (per manifest.schema.json). */
  id: string | null;
  wasmHash: string | null;
  package?: string;
};

export type CircuitArtifact = {
  witnessWasmHash: string | null;
  zkeyHash: string | null;
  r1csHash: string | null;
  verificationKeyHash: string | null;
  contractVkHash: string | null;
  zkeyHashBinding: string | null;
};

export type ReputationVerifierWiring = {
  admin: string;
  groth16Verifier: string;
};

export type AttestationEngineWiring = {
  admin: string;
  governance?: string;
  schemaRegistry: string;
  version?: number;
};

export type PrivacyPoolWiring = {
  admin: string;
  groth16Verifier: string;
  nativeSac: string;
  scope: number;
  depositPresetsXlm?: number[];
};

export type RelayerRegistryWiring = {
  admin: string;
  nativeSac: string;
  privacyPool: string;
  gatewayUrls?: string[];
  minimumStake: number;
  unstakeCooldownLedgers: number;
  maxDeadlineLedgers: number;
};

export type WiringBlock = {
  reputationVerifier?: ReputationVerifierWiring;
  attestationEngineV2?: AttestationEngineWiring;
  privacyPool?: PrivacyPoolWiring;
  relayerRegistry?: RelayerRegistryWiring;
};

export type DeploymentManifestV1 = {
  schemaVersion: "1.0.0";
  release: string;
  network: DeploymentNetwork;
  networkPassphrase: string;
  rpcUrl?: string;
  horizonUrl?: string;
  deploymentLedger: number | null;
  deployedAt: string | null;
  deployer: string | null;
  admin: string | null;
  multisig: string | null;
  wiring: WiringBlock | null;
  deploymentStatus: DeploymentStatus;
  /**
   * `OptionalContractKey` entries may be absent until first deployed;
   * this matches `manifest.schema.json` and `scripts/verify-deployment-manifest.ts`.
   */
  contracts: Record<Exclude<ContractKey, OptionalContractKey>, ContractRecord> &
    Partial<Record<OptionalContractKey, ContractRecord>>;
  artifacts: {
    frontend: {
      buildCommit: string | null;
      repository?: string;
    };
    scanner?: {
      wasmHash: string | null;
    };
    circuits: {
      v1: CircuitArtifact;
      v2: CircuitArtifact;
      v3?: CircuitArtifact;
    };
  };
  verification?: {
    command: string;
    output: string | null;
  };
};

export const CONTRACT_KEYS: readonly ContractKey[] = [
  "stealthRegistry",
  "stealthAnnouncer",
  "groth16Verifier",
  "reputationVerifier",
  "schemaRegistry",
  "attestationEngineV2",
  "poolVerifier",
  "privacyPool",
  "relayerRegistry",
  "multisigAdmin",
] as const;

export const CONTRACT_ENV_SUFFIX: Record<ContractKey, string> = {
  stealthRegistry: "STEALTH_REGISTRY_CONTRACT",
  stealthAnnouncer: "STEALTH_ANNOUNCER_CONTRACT",
  groth16Verifier: "GROTH16_VERIFIER_CONTRACT",
  reputationVerifier: "REPUTATION_VERIFIER_CONTRACT",
  schemaRegistry: "SCHEMA_REGISTRY_CONTRACT",
  attestationEngineV2: "ATTESTATION_ENGINE_CONTRACT",
  poolVerifier: "POOL_VERIFIER_CONTRACT",
  privacyPool: "PRIVACY_POOL_CONTRACT",
  relayerRegistry: "RELAYER_REGISTRY_CONTRACT",
  multisigAdmin: "MULTISIG_ADMIN_ADDRESS",
};

export function contractEnvKey(network: DeploymentNetwork, key: ContractKey): string {
  return `VITE_${network.toUpperCase()}_${CONTRACT_ENV_SUFFIX[key]}`;
}

export function isValidStellarContractId(value: string): boolean {
  return /^C[A-Z2-7]{55}$/.test(value);
}

export function manifestContractIds(
  manifest: DeploymentManifestV1,
): Record<ContractKey, string> {
  return Object.fromEntries(
    CONTRACT_KEYS.map((key) => [key, manifest.contracts[key]?.id ?? ""]),
  ) as Record<ContractKey, string>;
}
