/**
 * Monitoring and observability for contract calls, scanner health, and indexer lag.
 *
 * Collects metrics in memory and exposes them for dashboard consumption and
 * alerting. Designed to be consumed by a Prometheus-compatible endpoint or
 * logged to stdout for log-based monitoring.
 */

const MAX_METRICS = 10_000;

export type MetricTag = "contract_call" | "scanner_sync" | "rpc_error" | "proof_verification" | "admin_action" | "balance_check";

export type MetricEvent = {
  tag: MetricTag;
  success: boolean;
  durationMs: number;
  timestamp: number;
  contractId?: string;
  method?: string;
  error?: string;
  ledger?: number;
};

const metrics: MetricEvent[] = [];

function record(event: MetricEvent): void {
  metrics.push(event);
  if (metrics.length > MAX_METRICS) metrics.shift();
  if (!event.success) {
    console.warn(`[Monitoring] ${event.tag} failed${event.error ? `: ${event.error}` : ""}`);
  }
}

export function getMetrics(): readonly MetricEvent[] {
  return metrics;
}

export function clearMetrics(): void {
  metrics.length = 0;
}

export function recordContractCall(opts: {
  contractId: string;
  method: string;
  success: boolean;
  durationMs: number;
  error?: string;
}): void {
  record({
    tag: "contract_call",
    success: opts.success,
    durationMs: opts.durationMs,
    timestamp: Date.now(),
    contractId: opts.contractId,
    method: opts.method,
    error: opts.error,
  });
}

export function recordScannerSync(opts: {
  success: boolean;
  durationMs: number;
  fromLedger: number;
  toLedger: number;
  announcementsFound: number;
  error?: string;
}): void {
  record({
    tag: "scanner_sync",
    success: opts.success,
    durationMs: opts.durationMs,
    timestamp: Date.now(),
    ledger: opts.toLedger,
    error: opts.error,
  });
}

export function recordRpcError(opts: {
  provider: string;
  method: string;
  error: string;
}): void {
  record({
    tag: "rpc_error",
    success: false,
    durationMs: 0,
    timestamp: Date.now(),
    contractId: opts.provider,
    method: opts.method,
    error: opts.error,
  });
}

export function recordProofVerification(opts: {
  success: boolean;
  durationMs: number;
  error?: string;
}): void {
  record({
    tag: "proof_verification",
    success: opts.success,
    durationMs: opts.durationMs,
    timestamp: Date.now(),
    error: opts.error,
  });
}

export function recordAdminAction(opts: {
  action: string;
  success: boolean;
  durationMs: number;
  error?: string;
}): void {
  record({
    tag: "admin_action",
    success: opts.success,
    durationMs: opts.durationMs,
    timestamp: Date.now(),
    method: opts.action,
    error: opts.error,
  });
}

export function recordBalanceCheck(opts: {
  address: string;
  balance: bigint;
  success: boolean;
}): void {
  record({
    tag: "balance_check",
    success: opts.success,
    durationMs: 0,
    timestamp: Date.now(),
    contractId: opts.address,
  });
}

// Alert thresholds

export type AlertRule = {
  name: string;
  description: string;
  severity: "critical" | "warning" | "info";
  check: (metrics: readonly MetricEvent[]) => string | null;
};

const FIVE_MIN_MS = 5 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;

export const ALERT_RULES: AlertRule[] = [
  {
    name: "root_expiry",
    description: "No successful scanner sync in the last 5 minutes",
    severity: "critical",
    check: (m: readonly MetricEvent[]): string | null => {
      const recent = m.filter(
        (e) => e.tag === "scanner_sync" && e.success && Date.now() - e.timestamp < FIVE_MIN_MS,
      );
      if (recent.length === 0) return "Scanner has not synced successfully in the last 5 minutes";
      return null;
    },
  },
  {
    name: "rpc_failures",
    description: "More than 3 RPC failures in the last hour",
    severity: "warning",
    check: (m: readonly MetricEvent[]): string | null => {
      const recent = m.filter(
        (e) => e.tag === "rpc_error" && Date.now() - e.timestamp < ONE_HOUR_MS,
      );
      if (recent.length > 3) return `${recent.length} RPC failures in the last hour`;
      return null;
    },
  },
  {
    name: "high_tx_failure_rate",
    description: "Contract call failure rate exceeds 20% in the last hour",
    severity: "warning",
    check: (m: readonly MetricEvent[]): string | null => {
      const recent = m.filter(
        (e) => e.tag === "contract_call" && Date.now() - e.timestamp < ONE_HOUR_MS,
      );
      if (recent.length < 5) return null;
      const failures = recent.filter((e) => !e.success).length;
      const rate = failures / recent.length;
      if (rate > 0.2) return `Transaction failure rate ${(rate * 100).toFixed(1)}% (${failures}/${recent.length})`;
      return null;
    },
  },
  {
    name: "proof_verification_failures",
    description: "Proof verification failures detected in the last hour",
    severity: "critical",
    check: (m: readonly MetricEvent[]): string | null => {
      const recent = m.filter(
        (e) => e.tag === "proof_verification" && !e.success && Date.now() - e.timestamp < ONE_HOUR_MS,
      );
      if (recent.length > 0) return `${recent.length} proof verification failure(s) in the last hour`;
      return null;
    },
  },
];

export function evaluateAlertRules(): Array<{ rule: AlertRule; message: string }> {
  const fired: Array<{ rule: AlertRule; message: string }> = [];
  for (const rule of ALERT_RULES) {
    const result = rule.check(metrics);
    if (result !== null) {
      fired.push({ rule, message: result });
    }
  }
  return fired;
}

export function getContractCallFailureRate(hoursBack: number = 1): number {
  const cutoff = Date.now() - hoursBack * 60 * 60 * 1000;
  const calls = metrics.filter((e) => e.tag === "contract_call" && e.timestamp >= cutoff);
  if (calls.length === 0) return 0;
  const failures = calls.filter((e) => !e.success).length;
  return failures / calls.length;
}

export function getScannerLag(): number | null {
  const syncs = metrics.filter((e) => e.tag === "scanner_sync" && e.success);
  if (syncs.length === 0) return null;
  const latest = syncs[syncs.length - 1];
  if (!latest.ledger) return null;
  return latest.ledger;
}
