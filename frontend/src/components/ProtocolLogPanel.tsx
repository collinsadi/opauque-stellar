import { useEffect, useState } from "react";
import { useProtocolLog } from "../context/ProtocolLogContext";
import type { ProtocolLogSource } from "../context/ProtocolLogContext";
import { evaluateAlertRules } from "../lib/monitoring";
import type { AlertRule } from "../lib/monitoring";

const sourceLabel: Record<ProtocolLogSource, string> = {
  wasm: "WASM",
  blockchain: "CHAIN",
  ui: "UI",
};

const sourceClass: Record<ProtocolLogSource, string> = {
  wasm: "text-neutral-400",
  blockchain: "text-success",
  ui: "text-neutral-500",
};

type FiredAlert = { rule: AlertRule; message: string };

function severityBadgeClass(severity: AlertRule["severity"]): string {
  if (severity === "critical") return "border-neutral-500/30 bg-neutral-500/10 text-neutral-400";
  if (severity === "warning") return "border-neutral-400/30 bg-neutral-400/10 text-neutral-300";
  return "border-ink-600 bg-ink-800 text-mist";
}

function severityLabel(severity: AlertRule["severity"]): string {
  if (severity === "critical") return "CRIT";
  if (severity === "warning") return "WARN";
  return "INFO";
}

function downloadJson(data: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function ProtocolLogPanel() {
  const { entries, clear } = useProtocolLog();
  const [collapsed, setCollapsed] = useState(true);
  const [activeAlerts, setActiveAlerts] = useState<FiredAlert[]>([]);

  useEffect(() => {
    if (collapsed) return;
    const run = () => setActiveAlerts(evaluateAlertRules());
    run();
    const id = setInterval(run, 30_000);
    return () => clearInterval(id);
  }, [collapsed]);

  const handleExport = () => {
    downloadJson(
      {
        schemaVersion: 1,
        timestamp: Date.now(),
        alerts: activeAlerts.map((a) => ({
          rule: a.rule.name,
          severity: a.rule.severity,
          message: a.message,
        })),
        logEntries: entries,
      },
      "opaque-diagnostics.json",
    );
  };

  const alertCount = activeAlerts.length;
  const entryCount = entries.length;
  const countLabel =
    alertCount > 0
      ? `${alertCount} alert${alertCount !== 1 ? "s" : ""} · ${entryCount}`
      : entryCount > 0
        ? `${entryCount}`
        : "";

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-black">
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="w-full shrink-0 flex items-center justify-between px-4 sm:px-6 py-2 text-left text-sm font-mono text-neutral-600 hover:text-neutral-400 transition-colors"
      >
        <span>
          Log {countLabel && `(${countLabel})`}
          {alertCount > 0 && (
            <span className="ml-2 inline-flex items-center rounded-full border border-neutral-500/30 bg-neutral-500/10 px-1.5 py-0.5 text-[10px] font-medium text-neutral-400">
              {alertCount} alert{alertCount !== 1 ? "s" : ""}
            </span>
          )}
        </span>
        <span>{collapsed ? "+" : "−"}</span>
      </button>
      {!collapsed && (
        <div className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-6 pb-4">
          <div className="flex justify-end gap-2 mb-2">
            <button
              type="button"
              onClick={handleExport}
              className="text-xs font-mono text-neutral-600 hover:text-neutral-400 px-2 py-1 rounded-md border border-border hover:border-neutral-700 transition-colors"
            >
              Export
            </button>
            <button
              type="button"
              onClick={clear}
              className="text-xs font-mono text-neutral-600 hover:text-neutral-400 px-2 py-1 rounded-md border border-border hover:border-neutral-700 transition-colors"
            >
              Clear
            </button>
          </div>

          {activeAlerts.length > 0 && (
            <div className="mb-3 space-y-1">
              <p className="text-[10px] font-mono text-neutral-600 uppercase tracking-widest mb-1">Alerts</p>
              {activeAlerts.map((a) => (
                <div
                  key={a.rule.name}
                  className="flex items-baseline gap-2 font-mono text-xs"
                >
                  <span
                    className={`shrink-0 inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium ${severityBadgeClass(a.rule.severity)}`}
                  >
                    {severityLabel(a.rule.severity)}
                  </span>
                  <span className="text-neutral-500 shrink-0">{a.rule.name}</span>
                  <span className="text-neutral-400 break-all">{a.message}</span>
                </div>
              ))}
            </div>
          )}

          <ul className="space-y-1 font-mono text-xs">
            {entries.length === 0 ? (
              <li className="text-neutral-700">No entries yet.</li>
            ) : (
              entries.map((e) => (
                <li
                  key={e.id}
                  className="flex gap-2 items-baseline text-neutral-500"
                >
                  <span className={`shrink-0 w-12 ${sourceClass[e.source]}`}>
                    [{sourceLabel[e.source]}]
                  </span>
                  <span className="text-neutral-700 text-[10px] shrink-0">
                    {new Date(e.timestamp).toLocaleTimeString()}
                  </span>
                  <span className="break-all">{e.message}</span>
                </li>
              ))
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
