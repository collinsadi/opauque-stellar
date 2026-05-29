/**
 * Production feature flags — gates incomplete or risky UI (issue #128).
 *
 * Build-time: VITE_FEATURE_* env vars (see docs/FEATURE_FLAGS.md).
 * Runtime: optional window.__OPAQUE_FEATURE_FLAGS__ partial override (tests / staging).
 */

import { getNetwork, type StellarNetwork } from "./chain";

export type FeatureFlagKey =
  | "manualGhostAddresses"
  | "reputationProofs"
  | "schemaManagement"
  | "demoVerifierLinks"
  | "debugLogs";

export type FeatureFlags = Record<FeatureFlagKey, boolean>;

/** Vite env keys for each flag (documented in .env.example). */
export const FEATURE_FLAG_ENV: Record<FeatureFlagKey, string> = {
  manualGhostAddresses: "VITE_FEATURE_MANUAL_GHOST",
  reputationProofs: "VITE_FEATURE_REPUTATION_PROOFS",
  schemaManagement: "VITE_FEATURE_SCHEMA_MANAGEMENT",
  demoVerifierLinks: "VITE_FEATURE_DEMO_VERIFIER_LINKS",
  debugLogs: "VITE_FEATURE_DEBUG_LOGS",
};

declare global {
  interface Window {
    /** Runtime partial override — applied after build-time resolution. */
    __OPAQUE_FEATURE_FLAGS__?: Partial<FeatureFlags>;
  }
}

export function parseEnvBool(raw: string | undefined): boolean | undefined {
  if (raw == null || raw.trim() === "") return undefined;
  const v = raw.trim().toLowerCase();
  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no") return false;
  return undefined;
}

/**
 * Resolve a single flag.
 * Mainnet defaults to false unless the env var is explicitly set to true.
 * Non-mainnet defaults to true unless explicitly set to false.
 */
export function resolveFeatureFlag(
  envKey: string,
  network: StellarNetwork,
  envValue: string | undefined,
  isDev: boolean,
  devDefaultForDebugOnly = false,
): boolean {
  const parsed = parseEnvBool(envValue);
  if (parsed !== undefined) return parsed;

  if (network === "mainnet") return false;

  if (devDefaultForDebugOnly) return isDev;
  return true;
}

function readEnv(key: string): string | undefined {
  return (import.meta.env[key] as string | undefined)?.trim();
}

/** Pure resolver for unit tests and documentation. */
export function buildFeatureFlags(opts: {
  network: StellarNetwork;
  env: Record<string, string | undefined>;
  isDev: boolean;
  runtimeOverride?: Partial<FeatureFlags>;
}): FeatureFlags {
  const { network, env, isDev, runtimeOverride } = opts;

  const base: FeatureFlags = {
    manualGhostAddresses: resolveFeatureFlag(
      FEATURE_FLAG_ENV.manualGhostAddresses,
      network,
      env[FEATURE_FLAG_ENV.manualGhostAddresses],
      isDev,
    ),
    reputationProofs: resolveFeatureFlag(
      FEATURE_FLAG_ENV.reputationProofs,
      network,
      env[FEATURE_FLAG_ENV.reputationProofs],
      isDev,
    ),
    schemaManagement: resolveFeatureFlag(
      FEATURE_FLAG_ENV.schemaManagement,
      network,
      env[FEATURE_FLAG_ENV.schemaManagement],
      isDev,
    ),
    demoVerifierLinks: resolveFeatureFlag(
      FEATURE_FLAG_ENV.demoVerifierLinks,
      network,
      env[FEATURE_FLAG_ENV.demoVerifierLinks],
      isDev,
    ),
    debugLogs: resolveFeatureFlag(
      FEATURE_FLAG_ENV.debugLogs,
      network,
      env[FEATURE_FLAG_ENV.debugLogs],
      isDev,
      true,
    ),
  };

  if (runtimeOverride) {
    return { ...base, ...runtimeOverride };
  }
  return base;
}

function resolveFeatureFlags(): FeatureFlags {
  const env: Record<string, string | undefined> = {};
  for (const key of Object.values(FEATURE_FLAG_ENV)) {
    env[key] = readEnv(key);
  }

  const runtimeOverride =
    typeof window !== "undefined" ? window.__OPAQUE_FEATURE_FLAGS__ : undefined;

  return buildFeatureFlags({
    network: getNetwork(),
    env,
    isDev: import.meta.env.DEV,
    runtimeOverride,
  });
}

/** Snapshot at module load; use getFeatureFlags() if runtime override may change. */
export const featureFlags: FeatureFlags = resolveFeatureFlags();

export function getFeatureFlags(): FeatureFlags {
  return resolveFeatureFlags();
}

export function isFeatureEnabled(flag: FeatureFlagKey): boolean {
  return getFeatureFlags()[flag];
}

/** Demo verifier app URL — only returned when demoVerifierLinks is enabled. */
export function getDemoVerifierUrl(): string | null {
  if (!getFeatureFlags().demoVerifierLinks) return null;
  const configured = readEnv("VITE_DEMO_VERIFIER_URL");
  if (configured) return configured;
  if (getNetwork() === "mainnet") return null;
  return null;
}

/** Human-readable labels for disabled-feature notices. */
export const FEATURE_LABELS: Record<FeatureFlagKey, string> = {
  manualGhostAddresses: "Manual ghost addresses",
  reputationProofs: "Reputation proofs (V2)",
  schemaManagement: "Schema & attestation management",
  demoVerifierLinks: "Demo verifier links",
  debugLogs: "Protocol debug logs",
};
