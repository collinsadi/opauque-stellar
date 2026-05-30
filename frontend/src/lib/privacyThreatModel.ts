/**
 * Canonical privacy threat-model copy for UI surfaces.
 * Keep aligned with docs/PROTOCOL_THREAT_MODEL.md
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
  "Incoming transfers use one-time stealth addresses (harder to link to a single deposit identity).",
  "View tags and on-device WASM scanning reduce what infrastructure must infer.",
  "Reputation proofs can show eligibility without revealing your everyday wallet address.",
  "Master signing keys stay in memory; ghost ephemeral keys are encrypted at rest.",
] as const;

export const PRIVACY_NOT_HIDDEN = [
  "On-chain amounts, fees, timing, and fee-payer wallets remain public.",
  "Your RPC provider sees which contracts and ledgers you query.",
  "Wallet signatures link registration, sends, and sweeps to your Freighter identity.",
  "ZK proofs reveal whichever trait fields you choose to disclose.",
  "Lost local ghost data may make funds permanently inaccessible.",
] as const;

/** Short bullets for mainnet / production modals */
export const MAINNET_PRIVACY_WARNINGS = [
  "Stealth addresses reduce linkability — they do not hide amounts, timing, or your fee-payer wallet.",
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
    implementation: "frontend/src/lib/ghostCrypto.ts, docs/GHOST_THREAT_MODEL.md",
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
    implementation: "networkValidation.ts, NetworkMismatchModal.tsx",
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
    implementation: "docs/canonical-schema-encoding.md",
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
    implementation: "TOKEN_SUPPORT_V1.md, useScanner.ts",
  },
  {
    id: "M14",
    threat: "Timing / amount linkage",
    mitigation: "User education (no on-chain hiding in v1)",
    implementation: "docs/PROTOCOL_THREAT_MODEL.md, UI callouts",
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
];

export const ADVERSARY_SUMMARY = [
  { name: "Chain observer", risk: "Timing, amounts, fee-payer linkage" },
  { name: "RPC / Horizon operator", risk: "Query patterns, IP metadata" },
  { name: "Wallet (Freighter)", risk: "Signatures tie actions to your G-address" },
  { name: "Browser extension / XSS", risk: "Password and key capture at runtime" },
  { name: "ZK verifier / integrator", risk: "Learns disclosed proof fields" },
] as const;
