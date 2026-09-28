/**
 * In-app help links: recovery and protocol notes live in README.md on GitHub.
 */

const DEFAULT_REPO = "https://github.com/collinsadi/opaque-stellar/blob/main";

function docsBaseUrl(): string {
  const fromEnv = import.meta.env.VITE_DOCS_BASE_URL as string | undefined;
  if (fromEnv?.trim()) return fromEnv.replace(/\/$/, "");
  return DEFAULT_REPO;
}

export type DocId =
  | "user-recovery"
  | "ghost-threat-model"
  | "payment-link-format"
  | "privacy-pool"
  | "proof-submission-privacy"
  | "pool-linkability";

const DOC_PATHS: Record<DocId, string> = {
  "user-recovery": "README.md#honest-trade-offs",
  "ghost-threat-model": "README.md#where-the-zero-knowledge-does-the-work",
  "payment-link-format": "README.md#what-opaque-does",
  "privacy-pool": "README.md#where-the-zero-knowledge-does-the-work",
  "proof-submission-privacy": "docs/PROOF_SUBMISSION_PRIVACY.md",
  "pool-linkability": "docs/PRIVACY_GUARANTEES.md",
};

export function getDocUrl(doc: DocId): string {
  return `${docsBaseUrl()}/${DOC_PATHS[doc]}`;
}

export function getUserRecoverySectionUrl(
  section:
    | "payment-link"
    | "manual-ghost"
    | "signature-keys"
    | "browser-session"
    | "ghost-backup"
    | "device-migration"
    | "what-to-backup",
): string {
  const anchors: Record<typeof section, string> = {
    "what-to-backup": "honest-trade-offs",
    "signature-keys": "security",
    "browser-session": "security",
    "payment-link": "where-the-zero-knowledge-does-the-work",
    "manual-ghost": "where-the-zero-knowledge-does-the-work",
    "ghost-backup": "honest-trade-offs",
    "device-migration": "honest-trade-offs",
  };
  const recoveryFile = DOC_PATHS["user-recovery"].split("#")[0];
  return `${docsBaseUrl()}/${recoveryFile}#${anchors[section]}`;
}
