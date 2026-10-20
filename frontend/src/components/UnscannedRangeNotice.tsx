import type { UnscannedRange } from "../lib/opaqueCache";

type UnscannedRangeNoticeProps = {
  ranges: UnscannedRange[];
  className?: string;
};

/**
 * Discloses ledgers the scanner could not read because they fell outside the
 * RPC retention window. Payments announced there are not found by this scan,
 * so the balance shown may be incomplete.
 */
export function UnscannedRangeNotice({ ranges, className = "" }: UnscannedRangeNoticeProps) {
  if (ranges.length === 0) return null;
  return (
    <div
      className={`rounded-xl border border-amber-500/40 bg-amber-950/20 px-4 py-3 text-sm text-amber-100/90 ${className}`}
      role="alert"
    >
      <p className="leading-relaxed">
        <span className="font-semibold text-amber-200">Incomplete scan: </span>
        {ranges.length === 1 ? "ledgers" : "ledger ranges"}{" "}
        {ranges.map((range, i) => (
          <span key={`${range.fromLedger}-${range.toLedger}`}>
            {i > 0 && ", "}
            {range.fromLedger.toLocaleString()} – {range.toLedger.toLocaleString()}
          </span>
        ))}{" "}
        {ranges.length === 1 ? "is" : "are"} older than the RPC node retains and could not
        be scanned. Payments sent to you in that range will not appear here.
        To recover them, connect to an archival RPC or indexer that still holds
        those ledgers and run a full rescan.
      </p>
    </div>
  );
}
