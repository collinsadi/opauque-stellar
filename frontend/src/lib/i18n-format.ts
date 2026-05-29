/**
 * i18n-safe number and date formatting (#110).
 *
 * Rules of the road:
 *   - PARSING amounts from user input is locale-INDEPENDENT. We accept
 *     `1,234.56` and `1234.56`; we never honour `1.234,56` (German
 *     comma-as-decimal), because the contract layer expects a canonical
 *     `decimal.decimal` string and silent interpretation drift is how
 *     funds get sent to the wrong stroop scale.
 *   - DISPLAY uses `Intl.NumberFormat` / `Intl.DateTimeFormat` with
 *     the user's locale so 1,234.56 XLM doesn't look foreign to a
 *     French user.
 *
 * All helpers accept an optional `locale` for tests + storybook;
 * production callers omit it and the browser's `navigator.language`
 * is used.
 */

const XLM_DECIMALS = 7;

/** Detect the most useful default locale on the runtime. */
function resolveLocale(locale?: string): string {
  if (locale) return locale;
  if (typeof navigator !== "undefined" && navigator.language) return navigator.language;
  return "en-US";
}

// ─── Amount display ─────────────────────────────────────────────────────────

/**
 * Format a stroops bigint or string as XLM with the caller's locale.
 *
 *   formatXlmFromStroops(12_345_670n, { locale: "en-US" }) → "1.234567"
 *   formatXlmFromStroops(12_345_670n, { locale: "de-DE" }) → "1,234567"
 */
export function formatXlmFromStroops(
  stroops: bigint | string | number,
  options: { locale?: string; minimumFractionDigits?: number; maximumFractionDigits?: number } = {},
): string {
  const bn = typeof stroops === "bigint" ? stroops : BigInt(stroops);
  const negative = bn < 0n;
  const abs = negative ? -bn : bn;
  const divisor = 10n ** BigInt(XLM_DECIMALS);
  const whole = abs / divisor;
  const fraction = abs % divisor;

  // We build the value as a fixed-point string `whole.fraction` and
  // re-parse with Intl to apply locale grouping/decimal — the
  // alternative (`Number(stroops) / 1e7`) loses precision at large
  // balances.
  const fractionStr = fraction.toString().padStart(XLM_DECIMALS, "0");
  const fixed = `${whole}.${fractionStr}`;
  const num = Number(fixed); // safe for typical wallet balances (< 9e9 XLM)

  const formatted = new Intl.NumberFormat(resolveLocale(options.locale), {
    minimumFractionDigits: options.minimumFractionDigits ?? 2,
    maximumFractionDigits: options.maximumFractionDigits ?? XLM_DECIMALS,
  }).format(num);

  return negative ? `-${formatted}` : formatted;
}

// ─── Amount parsing ────────────────────────────────────────────────────────

/**
 * Parse an amount string into stroops as a bigint, using the canonical
 * `.`-decimal-only convention regardless of user locale. Throws on
 * ambiguous values so the caller doesn't have to guess.
 */
export function parseXlmInput(input: string): bigint {
  const trimmed = input.trim();
  if (trimmed.length === 0) throw new Error("Amount is required");

  // Strip locale-INDEPENDENT thousand separators (commas only, after
  // we've already rejected `1.234,56` shape below). Then validate.
  const commaCount = (trimmed.match(/,/g) ?? []).length;
  const dotCount = (trimmed.match(/\./g) ?? []).length;
  if (dotCount > 1) {
    throw new Error("Amount must contain at most one decimal point");
  }
  // Reject `1.234,56` style outright — it's the German shape we DO NOT
  // honour. If a string contains both `,` and `.`, the LAST one must
  // be the dot (canonical decimal).
  if (commaCount > 0 && dotCount > 0) {
    const lastComma = trimmed.lastIndexOf(",");
    const lastDot = trimmed.lastIndexOf(".");
    if (lastComma > lastDot) {
      throw new Error(
        "Amount uses an unrecognised decimal format. Use a period (.) for the decimal separator.",
      );
    }
  }

  const cleaned = trimmed.replace(/,/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) {
    throw new Error("Amount must be a decimal number with no spaces or letters");
  }

  const [whole, frac = ""] = cleaned.replace(/^-/, "").split(".");
  if (frac.length > XLM_DECIMALS) {
    throw new Error(`Amount has too many decimals (max ${XLM_DECIMALS})`);
  }
  const stroops = BigInt(whole) * 10n ** BigInt(XLM_DECIMALS) + BigInt(frac.padEnd(XLM_DECIMALS, "0"));
  return cleaned.startsWith("-") ? -stroops : stroops;
}

// ─── Date display ──────────────────────────────────────────────────────────

/**
 * Locale-aware date display. Pass either an ISO string or a Date.
 * Uses the user's locale for short or long format.
 */
export function formatDateTime(
  input: Date | string | number,
  options: { locale?: string; dateStyle?: Intl.DateTimeFormatOptions["dateStyle"]; timeStyle?: Intl.DateTimeFormatOptions["timeStyle"] } = {},
): string {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat(resolveLocale(options.locale), {
    dateStyle: options.dateStyle ?? "medium",
    timeStyle: options.timeStyle ?? "short",
  }).format(d);
}

/** Date-only variant — useful for transaction history rows. */
export function formatDate(input: Date | string | number, locale?: string): string {
  return formatDateTime(input, { locale, dateStyle: "medium", timeStyle: undefined as never });
}
