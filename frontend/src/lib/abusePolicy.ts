/**
 * Abuse and sanctions policy — public contacts and routes.
 * Keep aligned with docs/ABUSE_AND_SANCTIONS_POLICY.md
 */

export const ABUSE_POLICY_ROUTE = "/abuse-policy";

export const ABUSE_POLICY_REPO_PATH = "docs/ABUSE_AND_SANCTIONS_POLICY.md";

export type ContactChannel = {
  label: string;
  email?: string;
  url?: string;
  description: string;
};

/** Public reporting and support contacts */
export const PUBLIC_CONTACTS = {
  abuse: {
    label: "Abuse reports",
    email: "abuse@opaqueprotocol.org",
    description: "Terms violations, sanctions concerns, phishing using official branding",
  },
  security: {
    label: "Security incidents",
    email: "security@opaqueprotocol.org",
    url: "https://github.com/collinsadi/opaque-stellar/security/advisories/new",
    description: "Vulnerabilities and active exploitation",
  },
  support: {
    label: "General support",
    url: "https://github.com/collinsadi/opaque-stellar/issues",
    description: "Bug reports and general questions (no sensitive victim data)",
  },
} as const satisfies Record<string, ContactChannel>;

/** Documented for operators — matches docs/internal/ABUSE_SANCTIONS_RUNBOOK.md */
export const INCIDENT_CONTACTS = {
  incidentEmail: "incident@opaqueprotocol.org",
  opsChannel: "#ops-channel (Discord)",
} as const;

export const INFRA_CAN_BLOCK = [
  "Hosted frontend or CDN artifacts we publish",
  "RPC or Horizon endpoints we operate (rate limits, IP blocks)",
  "Reputation root updates via governance multisig (#85)",
  "Issuer attestations where we are admin",
  "Documentation or payment-link pages on our domains",
] as const;

export const INFRA_CANNOT_BLOCK = [
  "User XLM in stealth or public Stellar accounts (non-custodial)",
  "Confirmed on-chain transactions (ledger immutability)",
  "Third-party wallet signing (e.g. Freighter)",
  "Stealth recipient deanonymization from protocol design alone",
  "Data already on the public Stellar blockchain",
  "Self-hosted forks of the open-source software",
] as const;

export const REPORTER_PRIVACY_GUARANTEES = [
  "Reports are used only for triage, response, and legal compliance.",
  "Reporter identities are not published without consent, except as required by law.",
  "Anonymous reports are accepted.",
  "We do not deanonymize blockchain users based on abuse reports alone.",
] as const;

export const ABUSE_ACK_SLA_BUSINESS_DAYS = 5;
