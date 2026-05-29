import { Link } from "react-router-dom";
import { LegalPageLayout } from "./LegalPageLayout";
import { ABUSE_POLICY_ROUTE, PUBLIC_CONTACTS } from "../lib/abusePolicy";

export function DisclaimerPage() {
  return (
    <LegalPageLayout title="Disclaimer">
      <section>
        <h2 className="text-white font-medium text-base mb-2">Experimental Software</h2>
        <p>
          The Opaque protocol is in <strong className="text-neutral-200">Beta</strong>.
          The software is experimental and is used at your own risk. Smart contracts and
          the frontend may contain bugs or change over time. We do not guarantee
          availability, correctness, or security of the system.
        </p>
      </section>

      <section>
        <h2 className="text-white font-medium text-base mb-2">No Financial Advice</h2>
        <p>
          This application is a tool, not a financial service. Nothing provided here
          constitutes investment, tax, or legal advice. You are solely responsible for
          your decisions regarding the use of the protocol and any assets.
        </p>
      </section>

      <section>
        <h2 className="text-white font-medium text-base mb-2">Regulatory Compliance</h2>
        <p>
          You are responsible for complying with your local tax and anti–money
          laundering (AML) laws. Use of privacy-preserving tools does not exempt you
          from applicable regulations. Ensure your use of Opaque is lawful in your
          jurisdiction.
        </p>
      </section>

      <section>
        <h2 className="text-white font-medium text-base mb-2">Sanctions &amp; Abuse Reporting</h2>
        <p>
          Opaque is non-custodial and does not screen counterparties on-chain. Operators
          cannot freeze user funds or reverse Stellar transactions. To report abuse or
          sanctions concerns regarding official deployments, see the{" "}
          <Link
            to={ABUSE_POLICY_ROUTE}
            className="text-sol-purple underline hover:text-white font-medium"
          >
            Abuse &amp; Sanctions Response Policy
          </Link>{" "}
          or email{" "}
          <a
            href={`mailto:${PUBLIC_CONTACTS.abuse.email}`}
            className="text-sol-purple underline hover:text-white font-medium"
          >
            {PUBLIC_CONTACTS.abuse.email}
          </a>
          .
        </p>
      </section>
    </LegalPageLayout>
  );
}
