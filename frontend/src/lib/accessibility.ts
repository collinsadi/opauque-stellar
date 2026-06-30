/**
 * Accessibility conformance statement — public data.
 * Keep aligned with docs/ACCESSIBILITY.md
 */

export const ACCESSIBILITY_ROUTE = "/accessibility";

export const ACCESSIBILITY_REPO_PATH = "docs/ACCESSIBILITY.md";

export const WCAG_TARGET_LEVEL = "WCAG 2.1 Level AA";

export const TESTED_VIEWS = [
  "Landing page",
  "Wallet setup",
  "Registration",
  "SEP-10 auth",
  "Dashboard",
  "Send",
  "Receive",
  "Private balance",
  "Transaction history",
  "Profile",
  "Manage",
  "My traits",
  "Reputation dashboard",
  "Pay / Pay success",
  "Legal pages (Privacy, Terms, Disclaimer, Abuse policy)",
] as const;

export type AccessibilityGap = {
  description: string;
  issueUrl: string;
};

export const KNOWN_GAPS: AccessibilityGap[] = [
  {
    description:
      "No automated accessibility enforcement in CI — violations are currently caught only in manual passes.",
    issueUrl: "https://github.com/collinsadi/opauque-stellar/issues/472",
  },
  {
    description:
      "Color contrast, full keyboard operability, and screen reader labeling have not been audited end-to-end against WCAG 2.1 AA.",
    issueUrl: "https://github.com/collinsadi/opauque-stellar/labels/accessibility",
  },
];

export const ACCESSIBILITY_CONTACT = {
  email: "accessibility@opaqueprotocol.org",
  reportUrl: "https://github.com/collinsadi/opauque-stellar/issues/new",
} as const;
