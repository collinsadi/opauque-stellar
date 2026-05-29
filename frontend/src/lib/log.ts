/**
 * Structured logger with redaction (#115).
 *
 * Production builds (`import.meta.env.PROD === true`) only emit
 * `warn` and `error` to the console by default. `info` and `debug`
 * are gated behind `localStorage["opaque-debug"] === "1"` (per-device
 * opt-in for triage); even then, every payload is redacted:
 *   - Stellar addresses (`G...` 56 chars) shrink to `GABCD...WXYZ`.
 *   - Hex blobs longer than 12 chars (private keys, proof material)
 *     are masked to `[redacted-32-byte]` style markers.
 *   - Anything tagged `__secret` on an object is dropped entirely.
 *
 * Anywhere in the codebase that currently calls `console.log`
 * directly should migrate to this module — the lint guard at the
 * bottom of `eslint.config.js` (added separately) makes the rule
 * stick.
 */

const DEV = typeof import.meta !== "undefined" && (import.meta as any).env?.DEV === true;

function debugEnabled(): boolean {
  if (DEV) return true;
  try {
    if (typeof localStorage === "undefined") return false;
    return localStorage.getItem("opaque-debug") === "1";
  } catch {
    return false;
  }
}

// ─── Redaction ──────────────────────────────────────────────────────────────

const STELLAR_ADDRESS_RE = /^[GMS][A-Z2-7]{55}$/;
const LONG_HEX_RE = /^(0x)?[0-9a-fA-F]{12,}$/;

export function redactAddress(value: unknown): string {
  if (typeof value !== "string") return "";
  if (value.length === 0) return "";
  if (STELLAR_ADDRESS_RE.test(value)) {
    return `${value.slice(0, 5)}…${value.slice(-4)}`;
  }
  // Soroban contract addresses (`C...`) share the same length but
  // start with C — handle them the same way.
  if (value.length === 56 && /^[CGM][A-Z2-7]{55}$/.test(value)) {
    return `${value.slice(0, 5)}…${value.slice(-4)}`;
  }
  return value;
}

function redactString(value: string): string {
  if (LONG_HEX_RE.test(value)) {
    return `[redacted-${Math.ceil(value.replace(/^0x/, "").length / 2)}-byte-hex]`;
  }
  if (STELLAR_ADDRESS_RE.test(value) || /^[CGM][A-Z2-7]{55}$/.test(value)) {
    return redactAddress(value);
  }
  return value;
}

/**
 * Walk an arbitrary payload and redact every sensitive-looking value.
 * Idempotent + safe to call on already-redacted output.
 */
export function redact<T = unknown>(input: T): T {
  return redactInner(input, new WeakSet()) as T;
}

function redactInner(input: unknown, seen: WeakSet<object>): unknown {
  if (input == null) return input;
  if (typeof input === "string") return redactString(input);
  if (typeof input === "number" || typeof input === "boolean") return input;
  if (typeof input === "bigint") return input.toString() + "n";
  if (Array.isArray(input)) return input.map((v) => redactInner(v, seen));
  if (typeof input === "object") {
    if (seen.has(input as object)) return "[circular]";
    seen.add(input as object);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (k.startsWith("__secret")) continue;
      if (/(privateKey|secretKey|seed|mnemonic|signingKey|encryptionKey)/i.test(k)) {
        out[k] = "[redacted-key]";
        continue;
      }
      out[k] = redactInner(v, seen);
    }
    return out;
  }
  return input;
}

// ─── Public API ─────────────────────────────────────────────────────────────

type Level = "debug" | "info" | "warn" | "error";

function emit(level: Level, args: unknown[]): void {
  const redacted = args.map(redact);
  switch (level) {
    case "debug":
      if (!debugEnabled()) return;
      // eslint-disable-next-line no-console
      console.debug(...redacted);
      return;
    case "info":
      if (!debugEnabled()) return;
      // eslint-disable-next-line no-console
      console.info(...redacted);
      return;
    case "warn":
      // eslint-disable-next-line no-console
      console.warn(...redacted);
      return;
    case "error":
      // eslint-disable-next-line no-console
      console.error(...redacted);
      return;
  }
}

export const log = {
  debug: (...args: unknown[]): void => emit("debug", args),
  info: (...args: unknown[]): void => emit("info", args),
  warn: (...args: unknown[]): void => emit("warn", args),
  error: (...args: unknown[]): void => emit("error", args),
  redactAddress,
  redact,
  /** Toggle the per-device debug opt-in. Useful from the devtools. */
  setDebugEnabled: (enabled: boolean): void => {
    try {
      if (typeof localStorage === "undefined") return;
      if (enabled) localStorage.setItem("opaque-debug", "1");
      else localStorage.removeItem("opaque-debug");
    } catch {
      // Ignore — quota / private-mode hiccups.
    }
  },
};
