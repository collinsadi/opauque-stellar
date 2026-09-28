/**
 * Canonical privacy threat-model copy for UI surfaces.
 * Threat model summary: see README.md § Privacy and in-app /privacy route.
 */

export const THREAT_MODEL_ROUTE = "/threat-model";

export type ThreatMitigation = {
  id: string;
  threat: string;
  mitigation: string;
  issue?: string;
  implementation: string;
};

export const PRIVACY_PROVIDED = [
  "Incoming transfers use one-time stealth addresses, so the recipient's main wallet does not appear as the payment destination.",
  "Browser-side WASM scanning and view tags reduce what hosted infrastructure must learn to find receives.",
  "Privacy-pool withdrawals can hide which eligible deposit funded a withdrawal when the association set is large enough.",
  "Relayed pool withdrawals can avoid submitting the final withdrawal from the user's connected wallet.",
  "Reputation proofs can show eligibility or traits without revealing the holder's everyday wallet address.",
  "Master signing keys stay in memory; ghost ephemeral keys and pool notes are stored locally and encrypted for backup flows.",
] as const;

export const PRIVACY_NOT_HIDDEN = [
  "On-chain amounts, fees, timestamps, contract calls, nullifiers, and fee-payer wallets remain public.",
  "Your RPC or Horizon provider can see which contracts, ledgers, and account histories you query.",
  "Wallet signatures can link registration, sends, deposits, sweeps, and some setup actions to your Freighter identity.",
  "The ASP policy and published roots determine which deposits are eligible for pool withdrawal.",
  "Relayers and gateways may observe request timing, selected jobs, endpoints, and encrypted payload delivery metadata.",
  "ZK proofs reveal whichever public inputs and trait fields you choose to disclose.",
  "Weak anonymity sets, uncommon amounts, or distinctive timing can still create linkage.",
  "Lost local ghost data, pool notes, or backup passwords may make funds permanently inaccessible.",
] as const;

/** Short bullets for mainnet / production modals */
export const MAINNET_PRIVACY_WARNINGS = [
  "Stealth addresses reduce linkability, but they do not hide amounts, timing, or your fee-payer wallet.",
  "RPC and Horizon providers can observe your scan and submit patterns.",
  "Device-bound ghost records are required to discover and sweep receives.",
] as const;

/** Context-specific callout copy */
export const SEND_PRIVACY_WARNING =
  "Sends are signed from your connected wallet and publish an on-chain announcement. Amount, timing, and fee payer remain visible to observers.";

export const SCANNER_PRIVACY_WARNING =
  "Balances depend on complete announcement data from your RPC or Horizon endpoint. Missed events may delay detection until you rescan.";

export const MITIGATIONS: ThreatMitigation[] = [
  {
    id: "M1",
    threat: "Address linkability",
    mitigation: "One-time DKSAP stealth Stellar accounts",
    implementation: "frontend/src/lib/stealth.ts",
  },
  {
    id: "M2",
    threat: "Announcement scan cost",
    mitigation: "1-byte view tag pre-filter",
    implementation: "scanner/, contracts/stealth-announcer/",
  },
  {
    id: "M3",
    threat: "View-tag false positives (~1/256)",
    mitigation: "Full ECDH derivation before spend",
    implementation: "scanner/src/lib.rs, PrivateBalanceView.tsx",
  },
  {
    id: "M4",
    threat: "Schema / event drift",
    mitigation: "Event version filtering + telemetry",
    issue: "#50",
    implementation: "scanner/src/lib.rs, stealth-announcer",
  },
  {
    id: "M5",
    threat: "Malformed announcement keys",
    mitigation: "Compressed secp256k1 prefix validation",
    issue: "#53",
    implementation: "scanner/src/lib.rs, stealth-announcer",
  },
  {
    id: "M6",
    threat: "Ghost key theft at rest",
    mitigation: "AES-256-GCM + PBKDF2 encrypted storage",
    implementation: "frontend/src/lib/ghostCrypto.ts",
  },
  {
    id: "M7",
    threat: "Master key persistence",
    mitigation: "Session memory only",
    implementation: "frontend/src/context/KeysContext.tsx",
  },
  {
    id: "M8",
    threat: "Wrong network signing",
    mitigation: "Pre-sign network validation",
    implementation: "networkValidation.ts → stellar.ts:invokeContractMethod, stellar.ts:sendNativePayment, SendView.tsx",
  },
  {
    id: "M9",
    threat: "Registration message replay",
    mitigation: "Domain-separated setup signatures",
    implementation: "frontend/src/lib/stealth.ts",
  },
  {
    id: "M10",
    threat: "ZK proof replay",
    mitigation: "On-chain Poseidon nullifiers",
    implementation: "contracts/attestation-engine-v2/, circuits/",
  },
  {
    id: "M11",
    threat: "Schema / attestation confusion",
    mitigation: "Canonical encoding + schema IDs",
    issue: "#44, #45",
    implementation: "contracts/schema-registry/, opaque-schema-core",
  },
  {
    id: "M12",
    threat: "Compromised reputation root",
    mitigation: "Emergency freeze + stale root UI",
    issue: "#85",
    implementation: "freezePolicy.ts, ReputationDashboardView.tsx",
  },
  {
    id: "M13",
    threat: "Accidental token UI on mainnet",
    mitigation: "XLM-only v1 scope",
    issue: "#111",
    implementation: "useScanner.ts",
  },
  {
    id: "M22",
    threat: "Ghost announcer clustering",
    mitigation:
      "Each on-chain ghost announcement uses a unique announcer account derived from the ghost's ephemeral key, so multiple announcements from the same user cannot be linked by a shared fee-payer. Residual risk: timing correlation between announcements and the funding of each announcer account.",
    implementation: "stealth.ts (deriveAnnouncerEphemeralKey), stealthLifecycle.ts (getAnnouncerAccount)",
  },
  {
    id: "M14",
    threat: "Timing / amount linkage",
    mitigation: "User education (no on-chain hiding in v1)",
    implementation: "UI callouts, privacyThreatModel.ts",
  },
  {
    id: "M15",
    threat: "RPC query metadata leakage",
    mitigation: "Self-hosted RPC; on-device WASM scan",
    implementation: "useScanner.ts, chain.ts",
  },
  {
    id: "M16",
    threat: "Proof over-disclosure",
    mitigation: "Selective disclosure trait picker",
    implementation: "ProveTraitModal.tsx",
  },
  {
    id: "M17",
    threat: "Local data loss",
    mitigation: "Encrypted backups + export",
    implementation: "BackupExport.tsx, SecuritySettings.tsx",
  },
  {
    id: "M18",
    threat: "Pool double spend",
    mitigation: "On-chain nullifier set and custody invariant checks",
    implementation: "contracts/privacy-pool/, circuits/v3/",
  },
  {
    id: "M19",
    threat: "Relayer payload tampering",
    mitigation: "Withdrawal proof binds recipient, amount, fee, relayer, and pool scope",
    implementation: "contracts/privacy-pool/, relayer/src/",
  },
  {
    id: "M20",
    threat: "ASP root mismatch",
    mitigation: "Wallet rebuilds state and association paths from public events",
    implementation: "asp/src/, frontend/src/lib/poolProver.ts",
  },
  {
    id: "M21",
    threat: "Weak anonymity set",
    mitigation: "User-facing pool warnings and association-set visibility",
    implementation: "PoolView.tsx, privacyThreatModel.ts",
  },
];

export const ADVERSARY_SUMMARY = [
  { name: "Chain observer", risk: "Timing, amounts, fee-payer linkage" },
  { name: "RPC / Horizon operator", risk: "Query patterns, IP metadata" },
  { name: "Wallet (Freighter)", risk: "Signatures tie actions to your G-address" },
  { name: "ASP operator", risk: "Association-set eligibility and root publication liveness" },
  { name: "Relayer / gateway operator", risk: "Withdrawal request timing and delivery metadata" },
  { name: "Browser extension / XSS", risk: "Password and key capture at runtime" },
  { name: "ZK verifier / integrator", risk: "Learns disclosed proof fields" },
] as const;
