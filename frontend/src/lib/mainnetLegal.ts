/**
 * Legal document paths and mainnet first-use gate helpers.
 */

export const MAINNET_LEGAL_DOCS = [
  { path: "/terms", label: "Terms of Service" },
  { path: "/privacy", label: "Privacy Policy" },
  { path: "/disclaimer", label: "Disclaimer" },
] as const;

export type MainnetLegalAckState = {
  expectedNetwork: string;
  hasAcknowledgedMainnetRisk: boolean;
};

/** True when the mainnet legal gate should block the app. */
export function requiresMainnetLegalAck(state: MainnetLegalAckState): boolean {
  return state.expectedNetwork === "mainnet" && !state.hasAcknowledgedMainnetRisk;
}

/** True when both checkboxes in the mainnet modal are satisfied. */
export function canProceedToMainnet(legalAccepted: boolean, fundsUnderstood: boolean): boolean {
  return legalAccepted && fundsUnderstood;
}
