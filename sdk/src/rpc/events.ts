/**
 * Shared `getEvents` pagination for the SDK's contract-event loops (announcement
 * scanning and privacy-pool state reconstruction). Both walk the same protocol —
 * a ledger-range first page, then opaque cursors until one stops advancing — so
 * the mechanics live here once: the retained-window retry, the page cap,
 * retention-gap reporting, and truncation reporting.
 *
 * Truncation is never silent. A loop that just stops at the cap returns an
 * incomplete scan (missed stealth payments) or an incomplete tree (a wrong
 * Merkle root) that is indistinguishable from a complete one. Every page
 * therefore says whether it is the last one, and a caller can ask for an
 * {@link EventTruncationError} instead of a truncated marker.
 *
 * Retention is never silent either. When the RPC has pruned the requested start
 * ledger, the ledgers it cannot serve are reported as a {@link RetentionGap} on
 * every page from the clamp onward, rather than quietly restarting the scan.
 */
import type { rpc } from "@stellar/stellar-sdk";
import { EventTruncationError } from "../errors/index";
import { parseOldestLedgerFromRangeError } from "./diagnostics";

/**
 * Default cap on `getEvents` pages per topic per scan (~20k events at the
 * 100-event page size). A scan that reaches it is reported as truncated.
 */
export const EVENT_PAGE_LIMIT = 200;

/** Events requested per `getEvents` page. */
export const EVENT_PAGE_SIZE = 100;

/** Ledgers a topic is scanned back over when the caller gives no start ledger. */
export const EVENT_LOOKBACK_LEDGERS = 16_000;

/**
 * Ledgers a scan could not read because the RPC has pruned them. Both ends are
 * inclusive. Results built from these ledgers are incomplete.
 */
export interface RetentionGap {
  /** First pruned ledger the scan was asked to start from (inclusive). */
  fromLedger: number;
  /** Last pruned ledger (inclusive); the first retained ledger is this + 1. */
  toLedger: number;
}

/** One `getEvents` response, plus how far the scan can be trusted to have read. */
export interface ContractEventPage {
  /**
   * Events from this response, undecoded — each caller decodes its own shape.
   * An event id already yielded by this scan is never repeated.
   */
  events: rpc.Api.EventResponse[];
  /**
   * Highest ledger represented in `events` (the scan's start ledger when empty).
   * That ledger may be only partly read: later pages can still add its events.
   */
  ledger: number;
  /**
   * Highest ledger the scan has read through. On the final page of a drained
   * scan this covers the quiet ledgers after the last event, so a cursor
   * persisted from it resumes past them instead of rescanning them forever.
   */
  endLedger: number;
  /** True on the last page of a fully drained scan — nothing was left unread. */
  complete: boolean;
  /** True when the page cap stopped the scan with events still unread. */
  truncated: boolean;
  /** Opaque `getEvents` cursor to continue the truncated scan from. */
  continuationCursor?: string;
  /**
   * Ledgers the scan skipped because the RPC has pruned them, when the requested
   * start predates its retention window. Set on every page from the clamp on, so
   * a consumer sees the gap whichever page it stops at. Absent when nothing was
   * clamped.
   */
  retentionGap?: RetentionGap;
}

export interface PaginateContractEventsOptions {
  /** Needs only `getEvents` + `getLatestLedger`, so stubs can drive it. */
  invoker: {
    getEvents(request: rpc.Server.GetEventsRequest): Promise<rpc.Api.GetEventsResponse>;
    getLatestLedger(): Promise<number>;
  };
  filters: rpc.Api.EventFilter[];
  /** Label used in truncation errors, e.g. `"privacy-pool:Deposit"`. */
  scope: string;
  /** First ledger to read (inclusive). Defaults to `latest - lookback`. */
  startLedger?: number;
  /** Lookback when no `startLedger` (default {@link EVENT_LOOKBACK_LEDGERS}). */
  lookback?: number;
  /** Events per page (default {@link EVENT_PAGE_SIZE}). */
  pageSize?: number;
  /** Page cap (default {@link EVENT_PAGE_LIMIT}); hitting it is truncation. */
  maxPages?: number;
  /** Raise {@link EventTruncationError} at the cap instead of yielding a marker. */
  throwOnTruncation?: boolean;
}

/**
 * Page through one event topic, yielding one page per `getEvents` response —
 * including the empty ones, which is what lets a caller advance a scan cursor
 * through a quiet range instead of rescanning it on every run.
 *
 * The scan drains when the RPC stops handing back an advancing cursor; the
 * response's `latestLedger` (falling back to the ledger the scan started at) is
 * what `endLedger` reports on that final page.
 *
 * The first page is retried from the oldest retained ledger when the RPC
 * rejects the requested range as outside the retention window. That retry is
 * reported through {@link ContractEventPage.retentionGap}.
 */
export async function* paginateContractEvents(
  opts: PaginateContractEventsOptions,
): AsyncGenerator<ContractEventPage, void, unknown> {
  const maxPages = Math.max(1, opts.maxPages ?? EVENT_PAGE_LIMIT);
  const pageSize = opts.pageSize ?? EVENT_PAGE_SIZE;
  const latest = await opts.invoker.getLatestLedger();
  let startLedger =
    opts.startLedger && opts.startLedger > 0
      ? opts.startLedger
      : Math.max(1, latest - (opts.lookback ?? EVENT_LOOKBACK_LEDGERS));

  const filters = opts.filters;
  let cursor: string | undefined;
  let prevCursor: string | undefined;
  // Highest ledger covered by a page read so far; the floor for the next page
  // so a quiet page never walks a yielded ledger backwards.
  let covered = startLedger;
  // Set when the RPC prunes the requested start; see ContractEventPage.retentionGap.
  let retentionGap: RetentionGap | undefined;
  // Every event id this scan has yielded. Cursor paging never re-reads a ledger,
  // so a repeated id means the RPC handed the same event back, which must not be
  // counted twice (a duplicated deposit would corrupt the reconstructed tree).
  const seenEventIds = new Set<string>();

  for (let page = 0; page < maxPages; page++) {
    let res: rpc.Api.GetEventsResponse;
    try {
      res = await opts.invoker.getEvents(
        cursor ? { cursor, filters, limit: pageSize } : { startLedger, filters, limit: pageSize },
      );
    } catch (err) {
      // getEvents pages ~10k ledgers at a time and can return empty pages
      // before the ones holding events; a start ledger older than the
      // retention window is rejected outright, so retry from its floor.
      const oldest = parseOldestLedgerFromRangeError(err);
      if (cursor || oldest == null || startLedger >= oldest) throw err;
      // Ledgers [requested start, oldest) are pruned and will never be read.
      retentionGap = { fromLedger: startLedger, toLedger: oldest - 1 };
      startLedger = oldest;
      covered = Math.max(covered, oldest);
      res = await opts.invoker.getEvents({ startLedger, filters, limit: pageSize });
    }

    const events = (res.events ?? []).filter((ev) => {
      if (!ev.id) return true;
      if (seenEventIds.has(ev.id)) return false;
      seenEventIds.add(ev.id);
      return true;
    });
    let ledger = covered;
    for (const ev of events) ledger = Math.max(ledger, Number(ev.ledger));
    covered = ledger;
    const endLedger = Math.max(ledger, Number(res.latestLedger ?? 0), latest);
    const gap = retentionGap ? { retentionGap } : {};

    const nextCursor = res.cursor;
    const drained = !nextCursor || nextCursor === prevCursor;
    if (drained) {
      yield { events, ledger, endLedger, complete: true, truncated: false, ...gap };
      return;
    }
    if (page + 1 >= maxPages) {
      if (opts.throwOnTruncation) {
        throw new EventTruncationError({
          scope: opts.scope,
          pagesRead: maxPages,
          pageCap: maxPages,
          // `ledger` may be only partly read, so the last ledger known to be
          // complete is the one before it.
          lastScannedLedger: Math.max(0, ledger - 1),
          continuationCursor: nextCursor,
        });
      }
      yield {
        events,
        ledger,
        endLedger,
        complete: false,
        truncated: true,
        continuationCursor: nextCursor,
        ...gap,
      };
      return;
    }
    prevCursor = nextCursor;
    cursor = nextCursor;
    yield { events, ledger, endLedger, complete: false, truncated: false, ...gap };
  }
}
