import { Link } from "react-router-dom";
import { LegalPageLayout } from "./LegalPageLayout";
import {
  ABUSE_ACK_SLA_BUSINESS_DAYS,
  INFRA_CAN_BLOCK,
  INFRA_CANNOT_BLOCK,
  PUBLIC_CONTACTS,
  REPORTER_PRIVACY_GUARANTEES,
} from "../lib/abusePolicy";

export function AbusePolicyPage() {
  return (
    <LegalPageLayout title="Abuse & Sanctions Response">
      <section>
        <h2 className="text-white font-medium text-base mb-2">Purpose</h2>
        <p>
          Opaque is a non-custodial protocol. This policy explains how we handle abuse
          reports, what infrastructure we can and cannot block, and what privacy guarantees
          apply to reporters and users.
        </p>
      </section>

      <section>
        <h2 className="text-white font-medium text-base mb-2">Prohibited use</h2>
        <p>
          Official deployments must not be used for sanctions evasion, fraud, money
          laundering where prohibited by law, malware distribution, or other unlawful
          activity. Privacy features do not exempt users from applicable regulations.
        </p>
      </section>

      <section>
        <h2 className="text-white font-medium text-base mb-2">How to report</h2>
        <p className="mb-3">
          Include a description, evidence (transaction hashes, URLs, addresses), timeframe,
          and optional contact information. We aim to acknowledge reports within{" "}
          {ABUSE_ACK_SLA_BUSINESS_DAYS} business days.
        </p>
        <ul className="space-y-3">
          {Object.values(PUBLIC_CONTACTS).map((contact) => (
            <li key={contact.label} className="rounded-lg border border-ink-700 bg-ink-900/30 p-3">
              <p className="font-medium text-white">{contact.label}</p>
              <p className="text-mist text-xs mt-1">{contact.description}</p>
              <p className="mt-2 font-mono text-sm">
                {contact.email && (
                  <a
                    href={`mailto:${contact.email}`}
                    className="text-sol-purple underline hover:text-white"
                  >
                    {contact.email}
                  </a>
                )}
                {contact.email && contact.url && (
                  <span className="text-mist mx-2">·</span>
                )}
                {contact.url && (
                  <a
                    href={contact.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sol-purple underline hover:text-white"
                  >
                    {contact.url.includes("security/advisories")
                      ? "Private security advisory"
                      : "GitHub Issues"}
                  </a>
                )}
              </p>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="text-white font-medium text-base mb-2">What we can block or limit</h2>
        <ul className="list-disc pl-5 space-y-2">
          {INFRA_CAN_BLOCK.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="text-white font-medium text-base mb-2">What we cannot block</h2>
        <ul className="list-disc pl-5 space-y-2">
          {INFRA_CANNOT_BLOCK.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="text-white font-medium text-base mb-2">Privacy guarantees</h2>
        <ul className="list-disc pl-5 space-y-2 mb-3">
          {REPORTER_PRIVACY_GUARANTEES.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <p>
          The reference app does not collect names, emails, or IP addresses during normal
          use. See also the{" "}
          <Link to="/privacy" className="text-sol-purple underline hover:text-white">
            Privacy Policy
          </Link>
          .
        </p>
      </section>

      <section>
        <h2 className="text-white font-medium text-base mb-2">Full policy</h2>
        <p>
          The complete policy and operator runbook are maintained in the repository:{" "}
          <a
            href="https://github.com/collinsadi/opaque-stellar/blob/main/docs/ABUSE_AND_SANCTIONS_POLICY.md"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sol-purple underline hover:text-white"
          >
            ABUSE_AND_SANCTIONS_POLICY.md
          </a>
        </p>
      </section>
    </LegalPageLayout>
  );
}
