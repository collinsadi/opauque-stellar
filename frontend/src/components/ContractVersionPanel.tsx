/**
 * ContractVersionPanel — shows the on-chain version for every deployed contract
 * and validates it against the expected major version.
 *
 * - Green badge   "v1.x.x"      — valid, matches EXPECTED_MAJOR_VERSION
 * - Amber badge   "v2.x.x ⚠"   — major-version mismatch; clients should upgrade
 * - Gray  badge   "unknown"     — contract does not expose version() yet
 *
 * Related: Issue #84 (contract version read methods), #83 (version inspection).
 */

import { useWallet } from "../hooks/useWallet";
import {
  useContractVersions,
  type UseContractVersionsResult,
} from "../hooks/useContractVersions";
import {
  formatVersion,
  EXPECTED_MAJOR_VERSION,
  UPGRADE_NOTES,
} from "../lib/contractVersion";
import type { ContractVersionInfo } from "../lib/contractVersion";

function VersionBadge({ info }: { info: ContractVersionInfo }) {
  if (info.status === "valid") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-mono font-medium text-emerald-400">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden />
        {formatVersion(info.version)}
      </span>
    );
  }
  if (info.status === "major-mismatch") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] font-mono font-medium text-amber-400">
        <span className="h-1.5 w-1.5 rounded-full bg-amber-400" aria-hidden />
        {formatVersion(info.version)} ⚠
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-ink-600 bg-ink-800 px-2 py-0.5 text-[11px] font-mono font-medium text-mist">
      <span className="h-1.5 w-1.5 rounded-full bg-mist/40" aria-hidden />
      unknown
    </span>
  );
}

function VersionRow({ info }: { info: ContractVersionInfo }) {
  const short = info.contractId
    ? `${info.contractId.slice(0, 8)}…${info.contractId.slice(-6)}`
    : "—";

  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-ink-800 bg-ink-900/60 px-4 py-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-white truncate">{info.contractName}</p>
        <p className="text-[11px] font-mono text-mist/60 mt-0.5" title={info.contractId}>
          {short}
        </p>
        {info.version?.storageVersion !== undefined && (
          <p className="text-[11px] text-mist/50 mt-0.5">
            storage schema v{info.version.storageVersion}
          </p>
        )}
      </div>
      <VersionBadge info={info} />
    </div>
  );
}

function MismatchWarning({ versions }: { versions: ContractVersionInfo[] }) {
  const mismatches = versions.filter((v) => v.status === "major-mismatch");
  if (mismatches.length === 0) return null;

  return (
    <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm">
      <p className="font-semibold text-amber-400 mb-1">Major version mismatch detected</p>
      <p className="text-amber-300/70 text-xs">
        The following contracts are running a major version other than v{EXPECTED_MAJOR_VERSION}.
        This frontend may be incompatible. Contact the deployment team before proceeding.
      </p>
      <ul className="mt-2 space-y-0.5">
        {mismatches.map((m) => (
          <li key={m.contractId} className="text-xs font-mono text-amber-400">
            {m.contractName}: {formatVersion(m.version)}
          </li>
        ))}
      </ul>
    </div>
  );
}

interface ContractVersionPanelProps {
  result: UseContractVersionsResult;
}

export function ContractVersionPanel({ result }: ContractVersionPanelProps) {
  const { versions, isLoading, error, refresh } = result;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-white">Contract Versions</h3>
          <p className="text-xs text-mist mt-0.5">
            Expected major version: <span className="font-mono text-sol-purple">v{EXPECTED_MAJOR_VERSION}</span>
          </p>
        </div>
        <button
          type="button"
          onClick={refresh}
          disabled={isLoading}
          className="rounded-lg border border-ink-700 bg-ink-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-ink-800 disabled:opacity-50 transition-colors"
        >
          {isLoading ? (
            <span className="flex items-center gap-1.5">
              <span className="h-3 w-3 animate-spin rounded-full border border-ink-600 border-t-white" />
              Loading…
            </span>
          ) : "Refresh"}
        </button>
      </div>

      {error && (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
          {error}
        </p>
      )}

      <MismatchWarning versions={versions} />

      <div className="space-y-2">
        {versions.map((info) => (
          <VersionRow key={info.contractId || info.contractName} info={info} />
        ))}
      </div>

      {/* Upgrade / rollback notes (Issue #83) */}
      <details className="group rounded-xl border border-ink-700 bg-ink-900/30">
        <summary className="flex cursor-pointer items-center justify-between px-4 py-3 text-xs font-medium text-mist hover:text-white transition-colors list-none">
          <span>Upgrade &amp; Rollback Notes</span>
          <svg
            className="h-4 w-4 transition-transform group-open:rotate-180"
            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
            aria-hidden
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </summary>
        <div className="border-t border-ink-700 px-4 py-4 space-y-3 text-xs text-mist">
          <div>
            <p className="font-semibold text-white mb-1">Upgrade authority</p>
            <p>{UPGRADE_NOTES.authority}</p>
          </div>
          <div>
            <p className="font-semibold text-white mb-1">Storage migration</p>
            <p>{UPGRADE_NOTES.migration}</p>
          </div>
          <div>
            <p className="font-semibold text-white mb-1">Rollback</p>
            <p>{UPGRADE_NOTES.rollback}</p>
          </div>
          <div>
            <p className="font-semibold text-white mb-1">Version inspection</p>
            <p>{UPGRADE_NOTES.inspection}</p>
          </div>
        </div>
      </details>
    </div>
  );
}

/** Self-contained version panel that fetches its own data. */
export function ContractVersionPanelConnected() {
  const { publicKey } = useWallet();
  const result = useContractVersions(publicKey);

  if (!publicKey) {
    return (
      <div className="rounded-xl border border-ink-700 bg-ink-900/30 px-4 py-6 text-center text-sm text-mist">
        Connect your wallet to read contract versions.
      </div>
    );
  }

  return <ContractVersionPanel result={result} />;
}
