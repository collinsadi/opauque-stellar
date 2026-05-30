import { LegalPageLayout } from "./LegalPageLayout";

export function TermsPage() {
  return (
    <LegalPageLayout title="Terms of Service">
      <section>
        <h2 className="text-white font-medium text-base mb-2">Non-Custodial Nature</h2>
        <p>
          Opaque is a set of smart contracts and a frontend interface. The developers
          and operators of this application never have access to your funds. You retain
          full control of your private keys and assets at all times. No one can freeze,
          seize, or move your funds without access to your keys.
        </p>
      </section>

      <section>
        <h2 className="text-white font-medium text-base mb-2">User Responsibility</h2>
        <p>
          You are solely responsible for the safety of your private keys and any local
          vault backups. Loss of keys or backup data may result in permanent loss of
          access to your funds. We recommend secure backup practices and do not store
          or recover keys on your behalf.
        </p>
      </section>

      <section>
        <h2 className="text-white font-medium text-base mb-2">Eligibility</h2>
        <p>
          You must be of legal age in your jurisdiction to use this service. Use is
          prohibited in jurisdictions where the use of non-custodial privacy tools or
          cryptocurrency is illegal. By using Opaque, you represent that you comply
          with all applicable laws in your location.
        </p>
      </section>

      <section>
        <h2 className="text-white font-medium text-base mb-2">Mainnet Use</h2>
        <p>
          When configured for Stellar Mainnet, Opaque privacy payment features move{" "}
          <strong className="text-neutral-200">real XLM</strong>. Mainnet transactions
          are irreversible. You are solely responsible for verifying network, contract
          IDs, and counterparties before sending or receiving value.
        </p>
      </section>

      <section>
        <h2 className="text-white font-medium text-base mb-2">Acceptable Use</h2>
        <p>
          You may not use Opaque for unlawful activity, sanctions evasion, fraud, money
          laundering, or any purpose prohibited by applicable law or by the distribution
          channel through which you access the app (including app store or domain policies).
          Privacy features do not exempt you from regulatory, tax, or sanctions obligations.
        </p>
      </section>

      <section>
        <h2 className="text-white font-medium text-base mb-2">Jurisdictional Restrictions</h2>
        <p>
          Opaque does not offer services in jurisdictions where non-custodial privacy
          payment tools or cryptocurrency use is restricted. You must not access mainnet
          features if doing so would violate local law. Operators may block or limit
          access where required by law or platform policy.
        </p>
      </section>
    </LegalPageLayout>
  );
}
