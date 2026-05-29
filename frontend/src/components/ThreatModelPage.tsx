import { Link } from "react-router-dom";
import { LegalPageLayout } from "./LegalPageLayout";
import {
  ADVERSARY_SUMMARY,
  MITIGATIONS,
  PRIVACY_NOT_HIDDEN,
  PRIVACY_PROVIDED,
} from "../lib/privacyThreatModel";

export function ThreatModelPage() {
  return (
    <LegalPageLayout title="Privacy Threat Model">
      <section>
        <h2 className="text-white font-medium text-base mb-2">Purpose</h2>
        <p>
          Opaque provides stealth receives and selective ZK reputation on Stellar. This page
          explains what the protocol hides, what remains visible, and how mitigations map to
          the implementation. For ghost-key encryption details, see{" "}
          <a
            href="https://github.com/robertocarlous/opauque-stellar/blob/main/docs/GHOST_THREAT_MODEL.md"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sol-purple underline hover:text-white"
          >
            Ghost Address Key Storage — Threat Model
          </a>{" "}
          in the repository.
        </p>
      </section>

      <section>
        <h2 className="text-white font-medium text-base mb-2">What Opaque provides</h2>
        <ul className="list-disc pl-5 space-y-2">
          {PRIVACY_PROVIDED.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="text-white font-medium text-base mb-2">What Opaque does not hide</h2>
        <ul className="list-disc pl-5 space-y-2">
          {PRIVACY_NOT_HIDDEN.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="text-white font-medium text-base mb-2">Adversaries</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm border-collapse">
            <thead>
              <tr className="border-b border-ink-700 text-mist">
                <th className="py-2 pr-4 font-medium">Adversary</th>
                <th className="py-2 font-medium">Primary risk</th>
              </tr>
            </thead>
            <tbody>
              {ADVERSARY_SUMMARY.map(({ name, risk }) => (
                <tr key={name} className="border-b border-ink-800/80">
                  <td className="py-2 pr-4 text-neutral-200">{name}</td>
                  <td className="py-2 text-mist">{risk}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="text-white font-medium text-base mb-2">Threat categories</h2>
        <div className="space-y-4">
          <div>
            <h3 className="text-neutral-200 font-medium text-sm mb-1">Linkage</h3>
            <p>
              Funding paths, withdrawal destinations, and wallet registration can link stealth
              activity back to your everyday Stellar identity. Use separate funding and sweep
              destinations where unlinkability matters.
            </p>
          </div>
          <div>
            <h3 className="text-neutral-200 font-medium text-sm mb-1">Timing &amp; amount analysis</h3>
            <p>
              Amounts, fees, and block timestamps remain public. Clustering analysis can correlate
              payments even when receive addresses differ.
            </p>
          </div>
          <div>
            <h3 className="text-neutral-200 font-medium text-sm mb-1">Wallet signatures</h3>
            <p>
              Freighter signs sends, registration, and some reputation actions. Those signatures
              bind protocol use to your connected G-address.
            </p>
          </div>
          <div>
            <h3 className="text-neutral-200 font-medium text-sm mb-1">RPC &amp; indexer metadata</h3>
            <p>
              Scanning paginates contract events through RPC or Horizon. Your provider may log IP,
              query filters, and session timing. On-device scanning does not conceal infrastructure
              metadata.
            </p>
          </div>
          <div>
            <h3 className="text-neutral-200 font-medium text-sm mb-1">Local storage</h3>
            <p>
              Ghost addresses and transaction logs live on your device. Cleared storage or lost
              backups can make funds permanently inaccessible. Encrypted ghost keys still fail
              against XSS at password entry.
            </p>
          </div>
          <div>
            <h3 className="text-neutral-200 font-medium text-sm mb-1">Proof disclosure (ZK)</h3>
            <p>
              Proving a trait reveals the fields you include in the proof to verifiers and the chain.
              Repeated proofs across apps may correlate the same stealth identity over time.
            </p>
          </div>
        </div>
      </section>

      <section>
        <h2 className="text-white font-medium text-base mb-2">Mitigations</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="border-b border-ink-700 text-mist">
                <th className="py-2 pr-3 font-medium">ID</th>
                <th className="py-2 pr-3 font-medium">Threat</th>
                <th className="py-2 pr-3 font-medium">Mitigation</th>
                <th className="py-2 pr-3 font-medium">Issue</th>
                <th className="py-2 font-medium">Implementation</th>
              </tr>
            </thead>
            <tbody>
              {MITIGATIONS.map((m) => (
                <tr key={m.id} className="border-b border-ink-800/80 align-top">
                  <td className="py-2 pr-3 font-mono text-neutral-400">{m.id}</td>
                  <td className="py-2 pr-3 text-neutral-200">{m.threat}</td>
                  <td className="py-2 pr-3">{m.mitigation}</td>
                  <td className="py-2 pr-3 font-mono text-mist">{m.issue ?? "—"}</td>
                  <td className="py-2 font-mono text-mist/80 break-all">{m.implementation}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="text-white font-medium text-base mb-2">Related policies</h2>
        <p>
          See also{" "}
          <Link to="/privacy" className="text-sol-purple underline hover:text-white">
            Privacy Policy
          </Link>
          ,{" "}
          <Link to="/disclaimer" className="text-sol-purple underline hover:text-white">
            Disclaimer
          </Link>
          , and the full{" "}
          <a
            href="https://github.com/robertocarlous/opauque-stellar/blob/main/docs/PROTOCOL_THREAT_MODEL.md"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sol-purple underline hover:text-white"
          >
            PROTOCOL_THREAT_MODEL.md
          </a>{" "}
          in the repository.
        </p>
      </section>
    </LegalPageLayout>
  );
}
