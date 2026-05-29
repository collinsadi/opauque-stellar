/**
 * String-based decimal parsing for XLM amounts to avoid floating-point precision issues.
 * XLM uses 7 decimal places (stroops = 10^-7 XLM).
 */

const STROOPS_PER_XLM = 10_000_000n;
const MAX_DECIMALS = 7;

/**
 * Parse XLM string to stroops using string-based decimal parsing.
 * Enforces exactly 7 decimal places and rejects invalid input.
 *
 * @param xlmString - XLM amount as string (e.g., "1.5", "0.0000001", "100")
 * @returns Amount in stroops (1 XLM = 10,000,000 stroops)
 * @throws Error if input is invalid or has more than 7 decimal places
 */
export function parseXlmToStroops(xlmString: string): bigint {
  const trimmed = xlmString.trim();

  if (!trimmed || trimmed === "") {
    throw new Error("XLM amount cannot be empty");
  }

  // Check for invalid characters
  if (!/^-?\d+\.?\d*$/.test(trimmed)) {
    throw new Error(`Invalid XLM amount: ${trimmed}`);
  }

  // Handle negative values
  const isNegative = trimmed.startsWith("-");
  const absolute = isNegative ? trimmed.slice(1) : trimmed;

  // Split into integer and decimal parts
  const parts = absolute.split(".");
  const integerPart = parts[0] || "0";
  const decimalPart = parts[1] || "";

  // Check decimal places
  if (decimalPart.length > MAX_DECIMALS) {
    throw new Error(
      `XLM amount has too many decimal places (max ${MAX_DECIMALS}): ${trimmed}`,
    );
  }

  // Pad decimal part to 7 digits
  const paddedDecimal = decimalPart.padEnd(MAX_DECIMALS, "0");

  // Combine and convert to bigint
  const stroopsString = integerPart + paddedDecimal;
  const stroops = BigInt(stroopsString);

  return isNegative ? -stroops : stroops;
}

/**
 * Parse Horizon balance string to stroops using string-based decimal parsing.
 * Horizon returns balances as decimal strings (e.g., "100.0000000").
 *
 * @param balanceString - Balance from Horizon API
 * @returns Amount in stroops
 */
export function parseHorizonBalanceToStroops(
  balanceString: string | undefined,
): bigint {
  if (!balanceString || balanceString.trim() === "") {
    return 0n;
  }

  try {
    return parseXlmToStroops(balanceString);
  } catch {
    // If parsing fails, return 0 (defensive for malformed API responses)
    return 0n;
  }
}

/**
 * Format stroops as XLM string with trailing zeros removed.
 *
 * @param stroops - Amount in stroops
 * @returns Formatted XLM string
 */
export function formatStroopsToXlm(stroops: bigint): string {
  const isNegative = stroops < 0n;
  const absolute = isNegative ? -stroops : stroops;

  const stroopsString = absolute.toString().padStart(MAX_DECIMALS + 1, "0");
  const integerPart = stroopsString.slice(0, -MAX_DECIMALS) || "0";
  const decimalPart = stroopsString.slice(-MAX_DECIMALS);

  // Remove trailing zeros
  const trimmedDecimal = decimalPart.replace(/0+$/, "");

  if (trimmedDecimal === "") {
    return isNegative ? `-${integerPart}` : integerPart;
  }

  return isNegative
    ? `-${integerPart}.${trimmedDecimal}`
    : `${integerPart}.${trimmedDecimal}`;
}
