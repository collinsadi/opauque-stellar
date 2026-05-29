import type { ReactNode } from "react";
import { getDocUrl, getUserRecoverySectionUrl, type DocId } from "../lib/docsLinks";

type RecoverySection =
  | "payment-link"
  | "manual-ghost"
  | "signature-keys"
  | "browser-session"
  | "ghost-backup"
  | "device-migration"
  | "what-to-backup";

type RecoveryDocLinkProps = {
  /** Link to a section of USER_RECOVERY.md */
  section?: RecoverySection;
  /** Link to another doc (ignores section) */
  doc?: DocId;
  className?: string;
  children?: ReactNode;
};

export function RecoveryDocLink({
  section,
  doc,
  className = "text-sol-purple hover:underline font-medium",
  children = "Recovery guide",
}: RecoveryDocLinkProps) {
  const href =
    section != null
      ? getUserRecoverySectionUrl(section)
      : getDocUrl(doc ?? "user-recovery");

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
    >
      {children}
    </a>
  );
}
