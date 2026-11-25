/**
 * Opt-in error reporting controls (#560).
 *
 * The panel is built around one promise: nothing leaves the device that the user has
 * not read. It therefore renders `previewErrorReport(...)` verbatim — the same string
 * `sendErrorReport` puts in the request body — rather than a prose summary of it.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { deployedAddresses } from "../contracts/deployedAddresses";
import { getNetwork } from "../lib/chain";
import { getFeatureFlags } from "../lib/featureFlags";
import { ProofGenerationError } from "../lib/errors";
import {
  buildDiagnosticsExport,
  buildErrorReport,
  discardReport,
  downloadDiagnosticsExport,
  isReportingAvailable,
  isReportingEnabled,
  previewDiagnosticsExport,
  previewErrorReport,
  sendErrorReport,
  setReportingEnabled,
  subscribeToPendingReports,
  type ErrorReport,
} from "../lib/errorReporting";

const card = "rounded-2xl border border-ink-700 bg-ink-900/60 p-5";

function appVersion(): string {
  return (import.meta.env.VITE_APP_VERSION as string | undefined)?.trim() || "dev";
}

/**
 * A representative failure, scrubbed exactly like a real one. Lets the user see the
 * shape of a report *before* opting in, rather than after.
 */
function sampleReport(): ErrorReport {
  return buildErrorReport(
    new ProofGenerationError({
      message: "Withdrawal proof generation failed: witness calculation error",
      circuit: "privacy_pool_withdraw",
      cause: new Error("Assert Failed at line 84"),
      context: { poolId: "CEXAMPLE", leafIndex: 12 },
    }),
    { network: getNetwork(), appVersion: appVersion() },
  );
}

function ReportBody({ json }: { json: string }) {
  return (
    <pre className="mt-2 max-h-72 overflow-auto rounded-xl border border-ink-700 bg-ink-950/80 p-3 font-mono text-[11px] leading-relaxed text-mist/90">
      {json}
    </pre>
  );
}

function diagnosticsSample(): string {
  const contractIds = Object.fromEntries(
    Object.entries(deployedAddresses)
      .filter(([key, value]) => key !== "network" && typeof value === "string")
      .map(([key, value]) => [key, value as string]),
  );

  return previewDiagnosticsExport(
    buildDiagnosticsExport({
      appVersion: appVersion(),
      network: getNetwork(),
      contractIds,
      featureFlags: getFeatureFlags(),
      syncStatus: { scanner: "ready", lastLedger: 12345, lastUpdatedAt: "2026-08-25T10:00:00Z" },
      errors: [
        buildErrorReport(
          new ProofGenerationError({
            message: "Withdrawal proof generation failed: witness calculation error",
            circuit: "privacy_pool_withdraw",
            context: { poolId: contractIds.stealthRegistry ?? "CEXAMPLE", leafIndex: 12 },
          }),
          { network: getNetwork(), appVersion: appVersion() },
        ),
      ],
    }),
  );
}

export function ErrorReportingSettings() {
  const [enabled, setEnabled] = useState(() => isReportingEnabled());
  const [pending, setPending] = useState<readonly ErrorReport[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showSample, setShowSample] = useState(false);
  const [showDiagnosticsExport, setShowDiagnosticsExport] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [sendingId, setSendingId] = useState<string | null>(null);

  const available = useMemo(() => isReportingAvailable(), []);
  const sample = useMemo(() => previewErrorReport(sampleReport()), []);
  const diagnosticsPreview = useMemo(() => diagnosticsSample(), []);

  useEffect(() => subscribeToPendingReports(setPending), []);

  const toggle = useCallback((next: boolean) => {
    setReportingEnabled(next);
    setEnabled(isReportingEnabled());
    setStatus(
      next
        ? "Error reporting enabled. Reports are queued locally and only sent when you press Send."
        : "Error reporting disabled. Any queued reports were discarded.",
    );
  }, []);

  const send = useCallback(async (report: ErrorReport) => {
    setSendingId(report.id);
    setStatus(null);
    const result = await sendErrorReport(report);
    setSendingId(null);
    setStatus(
      result.ok
        ? "Report sent. Thank you."
        : result.reason === "unconfigured"
          ? "No collector is configured for this build, so nothing was sent."
          : result.reason === "disabled"
            ? "Reporting is switched off, so nothing was sent."
            : `Could not send the report${result.detail ? ` (${result.detail})` : ""}. It is still queued.`,
    );
  }, []);

  return (
    <div className={card}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-lg font-semibold text-white">Error reporting</h3>
          <p className="mt-1 max-w-prose text-sm leading-relaxed text-mist/70">
            Off by default. When enabled, failures are captured locally, stripped of
            addresses, amounts, notes, and keys, and held in a queue. Nothing is
            transmitted until you review a report and press Send.
          </p>
        </div>
        <label className="flex shrink-0 cursor-pointer items-center gap-2 text-sm text-white">
          <input
            type="checkbox"
            role="switch"
            checked={enabled}
            onChange={(e) => toggle(e.target.checked)}
            className="h-4 w-4 accent-glow"
          />
          {enabled ? "Enabled" : "Disabled"}
        </label>
      </div>

      <dl className="mt-4 grid gap-2 text-xs text-mist/70 sm:grid-cols-2">
        <div className="rounded-xl border border-ink-700 bg-ink-950/40 p-3">
          <dt className="font-medium text-white">Never included</dt>
          <dd className="mt-1 leading-relaxed">
            Stellar and contract addresses, XLM amounts, note nullifiers and secrets,
            commitments, proofs, signatures, payment-link query strings, seed phrases,
            and exact timestamps.
          </dd>
        </div>
        <div className="rounded-xl border border-ink-700 bg-ink-950/40 p-3">
          <dt className="font-medium text-white">Included</dt>
          <dd className="mt-1 leading-relaxed">
            Error class and code, the pipeline stage, a scrubbed message, stack frames
            reduced to file and line, the network name, the build version, and a coarse
            browser/platform label.
          </dd>
        </div>
      </dl>

      {!available && (
        <p className="mt-3 rounded-xl border border-warning/30 bg-warning/10 p-3 text-xs text-warning">
          This build has no reporting collector configured, so reports can be captured
          and inspected but not sent.
        </p>
      )}

      <div className="mt-4 space-y-3">
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setShowSample((v) => !v)}
            className="min-h-9 rounded-lg border border-ink-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:border-glow hover:text-glow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-glow"
            aria-expanded={showSample}
          >
            {showSample ? "Hide example report" : "Show an example report"}
          </button>
          <button
            type="button"
            onClick={() => setShowDiagnosticsExport((v) => !v)}
            className="min-h-9 rounded-lg border border-ink-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:border-glow hover:text-glow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-glow"
            aria-expanded={showDiagnosticsExport}
          >
            {showDiagnosticsExport ? "Hide diagnostics export" : "Review diagnostics export"}
          </button>
          <button
            type="button"
            onClick={() => {
              const exportPayload = buildDiagnosticsExport({
                appVersion: appVersion(),
                network: getNetwork(),
                contractIds: Object.fromEntries(
                  Object.entries(deployedAddresses).filter(
                    ([key, value]) => key !== "network" && typeof value === "string",
                  ),
                ),
                featureFlags: getFeatureFlags(),
                syncStatus: { scanner: "ready", lastLedger: 12345, lastUpdatedAt: new Date().toISOString() },
                errors: pending.length > 0 ? [...pending] : [sampleReport()],
              });
              downloadDiagnosticsExport(exportPayload, "opaque-diagnostics.json");
            }}
            className="min-h-9 rounded-lg bg-glow px-3 py-1.5 text-xs font-semibold text-ink-950 transition-colors hover:bg-[#ffe24f]"
          >
            Download JSON
          </button>
        </div>

        {showSample && (
          <>
            <p className="mt-2 text-xs text-mist/60">
              This is a real report built from a sample failure, scrubbed by the same
              code path as a live one.
            </p>
            <ReportBody json={sample} />
          </>
        )}

        {showDiagnosticsExport && (
          <>
            <p className="mt-2 text-xs text-mist/60">
              Sanitized diagnostics export: app version, network, contract IDs, feature
              flags, and non-sensitive sync status only. Keys, proofs, signatures, and
              raw metadata stay outside the bundle.
            </p>
            <ReportBody json={diagnosticsPreview} />
          </>
        )}
      </div>

      {status && (
        <p className="mt-3 rounded-xl border border-ink-700 bg-ink-950/40 p-3 text-xs text-mist/80">
          {status}
        </p>
      )}

      <div className="mt-5">
        <h4 className="text-sm font-medium text-white">
          Queued reports {pending.length > 0 && `(${pending.length})`}
        </h4>
        {pending.length === 0 ? (
          <p className="mt-1 text-xs text-mist/50">
            {enabled
              ? "No failures captured in this session."
              : "Reporting is off, so nothing is being captured."}
          </p>
        ) : (
          <ul className="mt-2 space-y-2">
            {pending.map((report) => {
              const open = expandedId === report.id;
              return (
                <li key={report.id} className="rounded-xl border border-ink-700 bg-ink-950/40 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm text-white">{report.name}</p>
                      <p className="truncate font-mono text-[11px] text-mist/60">
                        {report.code} · {report.stage}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => setExpandedId(open ? null : report.id)}
                        aria-expanded={open}
                        className="min-h-9 rounded-lg border border-ink-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:border-glow hover:text-glow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-glow"
                      >
                        {open ? "Hide" : "Inspect"}
                      </button>
                      <button
                        type="button"
                        onClick={() => void send(report)}
                        disabled={!available || sendingId === report.id}
                        className="min-h-9 rounded-lg bg-glow px-3 py-1.5 text-xs font-semibold text-ink-950 transition-colors hover:bg-[#ffe24f] disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {sendingId === report.id ? "Sending…" : "Send"}
                      </button>
                      <button
                        type="button"
                        onClick={() => discardReport(report.id)}
                        className="min-h-9 rounded-lg border border-ink-600 px-3 py-1.5 text-xs font-medium text-mist transition-colors hover:border-white/40 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-glow"
                      >
                        Discard
                      </button>
                    </div>
                  </div>
                  {open && <ReportBody json={previewErrorReport(report)} />}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
