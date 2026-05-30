import { Link } from "react-router-dom";
import { LegalPageLayout } from "./LegalPageLayout";
import { PRIVACY_NOT_HIDDEN, THREAT_MODEL_ROUTE } from "../lib/privacyThreatModel";

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
        <h2 className="text-white font-medium text-base mb-2">Privacy Threat Model</h2>
        <p className="mb-3">
          Opaque reduces address linkability but does not provide full anonymity. Before
          using stealth payments or ZK reputation in production, review what the protocol
          does and does not hide:
        </p>
        <ul className="list-disc pl-5 space-y-2 mb-3">
          {PRIVACY_NOT_HIDDEN.slice(0, 4).map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <p>
          <Link
            to={THREAT_MODEL_ROUTE}
            className="text-sol-purple underline hover:text-white font-medium"
          >
            Read the full privacy threat model
          </Link>{" "}
          for adversaries, mitigations mapped to issues and code, and residual risks.
        </p>
      </section>
    </LegalPageLayout>
  );
}
