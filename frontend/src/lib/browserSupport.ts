/**
 * Browser capability matrix for Opaque (WASM scanner, Freighter, IndexedDB, ZK proofs).
 * See docs/BROWSER_SUPPORT.md.
 */

export type BrowserSupportLevel = "supported" | "limited" | "unsupported";

export type BrowserCapability =
  | "webassembly"
  | "indexeddb"
  | "webcrypto"
  | "localstorage"
  | "clipboard"
  | "freighter";

export type BrowserSupportAssessment = {
  level: BrowserSupportLevel;
  isMobile: boolean;
  userAgent: string;
  missing: BrowserCapability[];
  warnings: string[];
};

function detectMobile(ua: string): boolean {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
}

function hasWebAssembly(): boolean {
  return (
    typeof WebAssembly !== "undefined" &&
    typeof WebAssembly.instantiate === "function"
  );
}

function hasWebCrypto(): boolean {
  return (
    typeof window !== "undefined" &&
    !!window.crypto?.subtle &&
    !!window.crypto?.getRandomValues
  );
}

function hasLocalStorage(): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    const k = "__opaque_cap_probe__";
    localStorage.setItem(k, "1");
    localStorage.removeItem(k);
    return true;
  } catch {
    return false;
  }
}

function hasIndexedDB(): boolean {
  return typeof window !== "undefined" && !!window.indexedDB;
}

function hasClipboard(): boolean {
  return (
    typeof navigator !== "undefined" &&
    !!navigator.clipboard?.writeText
  );
}

/** Freighter injects `window.freighter` or `window.freighterApi` in supported browsers. */
function hasFreighterHint(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as Window & {
    freighter?: unknown;
    freighterApi?: unknown;
  };
  return !!(w.freighter || w.freighterApi);
}

/**
 * Assess runtime browser support. Call in browser only.
 * Freighter may be absent until the extension is installed — we warn, not block.
 */
export function assessBrowserSupport(
  userAgent: string = typeof navigator !== "undefined"
    ? navigator.userAgent
    : "",
): BrowserSupportAssessment {
  const isMobile = detectMobile(userAgent);
  const missing: BrowserCapability[] = [];
  const warnings: string[] = [];

  if (!hasWebAssembly()) missing.push("webassembly");
  if (!hasIndexedDB()) missing.push("indexeddb");
  if (!hasWebCrypto()) missing.push("webcrypto");
  if (!hasLocalStorage()) missing.push("localstorage");
  if (!hasClipboard()) missing.push("clipboard");
  if (!hasFreighterHint()) missing.push("freighter");

  if (missing.includes("webassembly") || missing.includes("webcrypto")) {
    return {
      level: "unsupported",
      isMobile,
      userAgent,
      missing,
      warnings: [
        "This browser cannot run the Opaque scanner or ZK proof engine.",
        "Use a recent desktop Chrome, Firefox, or Edge with the Freighter extension.",
      ],
    };
  }

  if (missing.includes("indexeddb") || missing.includes("localstorage")) {
    warnings.push(
      "Private browsing or strict storage blocking detected. Caches and ghost recovery may not persist.",
    );
  }

  if (!hasFreighterHint()) {
    warnings.push(
      "Freighter wallet extension not detected. Install Freighter to connect and sign.",
    );
  }

  if (isMobile) {
    warnings.push(
      "Mobile browsers have limited Freighter and proof-generation support. Desktop Chrome/Firefox is recommended.",
    );
  }

  const level: BrowserSupportLevel =
    missing.includes("webassembly") || missing.includes("webcrypto")
      ? "unsupported"
      : missing.length > 0 || isMobile
        ? "limited"
        : "supported";

  return {
    level: missing.includes("webassembly") || missing.includes("webcrypto")
      ? "unsupported"
      : level,
    isMobile,
    userAgent,
    missing,
    warnings,
  };
}

export function unsupportedBrowserMessage(
  assessment: BrowserSupportAssessment,
): string {
  if (assessment.level === "unsupported") {
    return (
      assessment.warnings[0] ??
      "Your browser does not meet the minimum requirements for Opaque."
    );
  }
  return assessment.warnings.join(" ");
}

/** Manual / automated test checklist for mobile-critical flows (issue #108). */
export const MOBILE_FLOW_CHECKLIST = [
  "Connect Freighter wallet",
  "Sign stealth key setup",
  "Send private payment",
  "Scan announcements (WASM)",
  "Generate reputation proof (snarkjs)",
  "Withdraw stealth balance",
  "Receive via payment link",
] as const;
