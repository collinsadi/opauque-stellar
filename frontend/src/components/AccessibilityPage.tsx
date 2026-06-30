import { LegalPageLayout } from "./LegalPageLayout";
import {
  ACCESSIBILITY_CONTACT,
  ACCESSIBILITY_REPO_PATH,
  KNOWN_GAPS,
  TESTED_VIEWS,
  WCAG_TARGET_LEVEL,
} from "../lib/accessibility";

export function AccessibilityPage() {
  return (
    <LegalPageLayout title="Accessibility">
      <section>
        <h2 className="text-white font-medium text-base mb-2">Target conformance level</h2>
        <p>
          Opaque Stellar targets <strong className="text-neutral-200">{WCAG_TARGET_LEVEL}</strong>.
          This is a target, not a certification — the application has not undergone a
          third-party accessibility audit. Conformance is based on internal manual review
          using keyboard navigation and screen reader spot checks (VoiceOver, NVDA).
        </p>
      </section>

      <section>
        <h2 className="text-white font-medium text-base mb-2">Tested views</h2>
        <p className="mb-3">Manual accessibility review has been performed on:</p>
        <ul className="list-disc pl-5 space-y-1">
          {TESTED_VIEWS.map((view) => (
            <li key={view}>{view}</li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="text-white font-medium text-base mb-2">Known gaps</h2>
        <ul className="space-y-3">
          {KNOWN_GAPS.map((gap) => (
            <li key={gap.issueUrl} className="rounded-lg border border-ink-700 bg-ink-900/30 p-3">
              <p>{gap.description}</p>
              <a
                href={gap.issueUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-white underline hover:text-white text-xs font-mono mt-2 inline-block"
              >
                {gap.issueUrl}
              </a>
            </li>
          ))}
        </ul>
        <p className="mt-3">
          This statement is updated as gaps are closed or new ones are found.
        </p>
      </section>

      <section>
        <h2 className="text-white font-medium text-base mb-2">Contact</h2>
        <p>
          Found an accessibility barrier? Email{" "}
          <a
            href={`mailto:${ACCESSIBILITY_CONTACT.email}`}
            className="text-white underline hover:text-white font-medium"
          >
            {ACCESSIBILITY_CONTACT.email}
          </a>{" "}
          or{" "}
          <a
            href={ACCESSIBILITY_CONTACT.reportUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-white underline hover:text-white font-medium"
          >
            open a GitHub issue
          </a>{" "}
          with the <code className="text-xs">accessibility</code> label.
        </p>
      </section>

      <section>
        <h2 className="text-white font-medium text-base mb-2">Full statement</h2>
        <p>
          The complete statement is maintained in the repository:{" "}
          <a
            href={`https://github.com/collinsadi/opauque-stellar/blob/main/${ACCESSIBILITY_REPO_PATH}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-white underline hover:text-white"
          >
            {ACCESSIBILITY_REPO_PATH}
          </a>
        </p>
      </section>
    </LegalPageLayout>
  );
}
