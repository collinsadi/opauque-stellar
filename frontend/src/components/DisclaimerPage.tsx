import { LegalPageLayout } from "./LegalPageLayout";

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
        <h2 className="text-white font-medium text-base mb-2">Mainnet Production Use</h2>
        <p>
          Mainnet deployments involve <strong className="text-neutral-200">real funds</strong>.
          Smart contracts and the frontend are experimental and have not undergone a formal
          production security audit. Account reserves, network fees, and failed transactions
          consume real XLM irreversibly. Do not use mainnet privacy payments unless you
          accept these risks and have completed your own legal and technical review.
        </p>
      </section>

      <section>
        <h2 className="text-white font-medium text-base mb-2">Sanctions and Counterparty Risk</h2>
        <p>
          Opaque is non-custodial and does not screen senders, recipients, or payment-link
          counterparties against sanctions lists or other compliance databases. You are
          solely responsible for ensuring your mainnet use complies with applicable sanctions
          and counterparty due-diligence requirements.
        </p>
      </section>
    </LegalPageLayout>
  );
}
