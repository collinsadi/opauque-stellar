import { getFeatureFlags } from "./featureFlags";

/** Console log gated by VITE_FEATURE_DEBUG_LOGS / mainnet defaults. */
export function debugLog(...args: unknown[]): void {
  if (getFeatureFlags().debugLogs) {
    console.log(...args);
  }
}

export function debugWarn(...args: unknown[]): void {
  if (getFeatureFlags().debugLogs) {
    console.warn(...args);
  }
}
