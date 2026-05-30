import { LegalPageLayout } from "./LegalPageLayout";

export function PrivacyPage() {
  return (
    <LegalPageLayout title="Privacy Policy">
      <section>
        <h2 className="text-white font-medium text-base mb-2">Data Collection</h2>
        <p>
          The Opaque protocol does <strong className="text-neutral-200">not</strong> collect
          IP addresses, names, or email addresses. No personally identifiable information
          is gathered or transmitted by the protocol or the application.
        </p>
      </section>

      <section>
        <h2 className="text-white font-medium text-base mb-2">Local Storage</h2>
        <p>
          &quot;Manual Ghost Addresses&quot; and &quot;Transaction Logs&quot; are stored
          locally on your device only. This data never touches a centralized server. You
          are responsible for backing up your local data; clearing browser storage will
          remove it.
        </p>
      </section>

      <section>
        <h2 className="text-white font-medium text-base mb-2">Blockchain Data</h2>
        <p>
          While Opaque provides privacy through stealth addresses and ECDH-derived
          one-time addresses, the underlying blockchain is public. You are responsible
          for managing your own &quot;linkability&quot;—for example, how you fund gas,
          which networks you use, and any off-chain metadata. The protocol does not
          control or obscure blockchain-level visibility.
        </p>
      </section>

      <section>
        <h2 className="text-white font-medium text-base mb-2">Mainnet Privacy Limits</h2>
        <p>
          On Stellar Mainnet, stealth payments reduce address linkability but do not
          guarantee anonymity. Timing, amounts, fees, RPC queries, and wallet metadata
          may still be observable. Local ghost-address data is stored only on your device;
          loss of that data may make mainnet funds permanently inaccessible with no
          on-chain recovery path.
        </p>
      </section>
    </LegalPageLayout>
  );
}
