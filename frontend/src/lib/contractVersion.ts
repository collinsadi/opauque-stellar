/**
 * Contract version types and validation.
 *
 * Each deployed Soroban contract is expected to expose a version() method
 * returning its semantic version. The frontend validates that the deployed
 * major version matches EXPECTED_MAJOR_VERSION before allowing interactions.
 *
 * Related: Issue #84 (add contract version read methods), #83 (upgrade/rollback strategy).
 */

/** Major version the frontend is built against. */
export const EXPECTED_MAJOR_VERSION = 1;

export interface ContractVersion {
  major: number;
  minor: number;
  patch: number;
  /** Storage schema version, if the contract exposes it. */
  storageVersion?: number;
  /** Raw value returned by the contract (for debugging). */
  raw?: string;
}

export type VersionStatus =
  | "valid"
  /** Deployed major version differs from EXPECTED_MAJOR_VERSION. */
  | "major-mismatch"
  /** Contract did not respond or version() is not yet implemented. */
  | "unknown";

export interface ContractVersionInfo {
  contractId: string;
  contractName: string;
  version: ContractVersion | null;
  status: VersionStatus;
}

/**
 * Parse a version from whatever the contract returns via scValToNative.
 *
 * Supported shapes:
 *   - string  "1.2.3" / "v1.2.3"
 *   - object  { major, minor, patch, storage_version? }
 *   - array   [major, minor, patch]
 */
export function parseVersionFromNative(native: unknown): ContractVersion | null {
  if (!native && native !== 0) return null;

  if (typeof native === "string") {
    const match = native.match(/v?(\d+)\.(\d+)\.(\d+)/);
    if (match) {
      return {
        major: parseInt(match[1], 10),
        minor: parseInt(match[2], 10),
        patch: parseInt(match[3], 10),
        raw: native,
      };
    }
    return null;
  }

  if (typeof native === "object" && native !== null && !Array.isArray(native)) {
    const m = native as Record<string, unknown>;
    const toNum = (v: unknown): number | null => {
      if (typeof v === "number") return v;
      if (typeof v === "bigint") return Number(v);
      return null;
    };
    const major = toNum(m.major);
    if (major === null) return null;
    return {
      major,
      minor: toNum(m.minor) ?? 0,
      patch: toNum(m.patch) ?? 0,
      storageVersion: toNum(m.storage_version) ?? undefined,
    };
  }

  if (Array.isArray(native) && native.length >= 2) {
    const [maj, min, pat] = native as unknown[];
    const toNum = (v: unknown): number | null => {
      if (typeof v === "number") return v;
      if (typeof v === "bigint") return Number(v);
      return null;
    };
    const major = toNum(maj);
    if (major === null) return null;
    return {
      major,
      minor: toNum(min) ?? 0,
      patch: toNum(pat) ?? 0,
    };
  }

  return null;
}

export function getVersionStatus(version: ContractVersion | null): VersionStatus {
  if (!version) return "unknown";
  if (version.major !== EXPECTED_MAJOR_VERSION) return "major-mismatch";
  return "valid";
}

export function formatVersion(version: ContractVersion | null): string {
  if (!version) return "unknown";
  return `v${version.major}.${version.minor}.${version.patch}`;
}

/**
 * Upgrade and rollback notes exposed to the UI (Issue #83).
 *
 * Soroban contracts are upgradeable via the built-in upgrade() host function,
 * but this requires the deployer account (or an authorised multisig account)
 * to sign the upgrade transaction. Storage migrations must be handled
 * in the new contract's initialise path.
 */
export const UPGRADE_NOTES = {
  authority: "Upgrade authority is the contract deployer account (or a delegated multisig).",
  migration:
    "Each storage key type documents its migration path in the contract source. " +
    "Migrations run lazily on first access after an upgrade.",
  rollback:
    "Rollback is performed by re-deploying the previous WASM hash via upgrade(). " +
    "Storage written by the newer version remains but is ignored by the rollback binary.",
  inspection:
    "Clients can inspect the current version by calling version() on each contract. " +
    "The deployment manifest records the expected WASM hash and version for each network.",
} as const;
