/**
 * Links to in-repo documentation on GitHub (user recovery, ghost threat model, etc.).
 * Override with VITE_DOCS_BASE_URL for forks or self-hosted doc mirrors.
 */

const DEFAULT_DOCS_REPO =
  "https://github.com/collinsadi/opaque-stellar/blob/main";

function docsBaseUrl(): string {
  const fromEnv = import.meta.env.VITE_DOCS_BASE_URL as string | undefined;
  if (fromEnv && fromEnv.trim() !== "") {
    return fromEnv.replace(/\/$/, "");
  }
  return DEFAULT_DOCS_REPO;
}

export type DocId =
  | "user-recovery"
  | "ghost-threat-model"
  | "payment-link-format";

const DOC_PATHS: Record<DocId, string> = {
  "user-recovery": "docs/USER_RECOVERY.md",
  "ghost-threat-model": "docs/GHOST_THREAT_MODEL.md",
  "payment-link-format": "docs/OPAQUE_PAYMENT_LINK_FORMAT.md",
};

export function getDocUrl(doc: DocId): string {
  return `${docsBaseUrl()}/${DOC_PATHS[doc]}`;
}

/** Anchor within USER_RECOVERY.md */
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
    "what-to-backup": "what-must-be-backed-up",
    "signature-keys": "signature-derived-master-keys",
    "browser-session": "browser-and-session-behavior",
    "payment-link": "payment-link-receives-recommended",
    "manual-ghost": "manual-ghost-receives-one-time-browser-bound",
    "ghost-backup": "ghost-address-backups",
    "device-migration": "device-migration-checklist",
  };
  return `${getDocUrl("user-recovery")}#${anchors[section]}`;
}
