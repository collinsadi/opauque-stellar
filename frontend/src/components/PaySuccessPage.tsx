/**
 * Success receipt after a private payment: /pay/success?tx=0x…
 */

import { useSearchParams, useNavigate } from "react-router-dom";
import { getExplorerTxUrl } from "../lib/explorer";

const ExternalLinkIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    <polyline points="15 3 21 3 21 9" />
    <line x1="10" y1="14" x2="21" y2="3" />
  </svg>
);

export function PaySuccessPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const txSig = searchParams.get("tx")?.trim() || null;
  const explorerUrl = txSig ? getExplorerTxUrl(txSig) : null;

  return (
    <div className="min-h-screen bg-ink-950 bg-grid-fade bg-size-grid text-white flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-md rounded-2xl border border-ink-700 bg-ink-900/30 p-6 text-center shadow-2xl backdrop-blur-lg">
        <h1 className="font-display text-2xl font-bold text-white mb-2">Transaction Sent</h1>
        <p className="text-mist text-sm mb-6">
          Your private payment was broadcast. The recipient can discover it using their stealth keys.
        </p>
        {txSig && (
          <div className="mb-6 p-3 rounded-xl bg-ink-950/50 border border-ink-700 font-mono text-xs text-mist break-all">
            {txSig}
          </div>
        )}
        <div className="flex flex-col gap-2">
          {explorerUrl && txSig && (
            <a
              href={explorerUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="w-full rounded-xl border border-ink-600 bg-ink-950/30 px-4 py-2.5 text-sm font-medium text-mist transition-colors hover:border-white/30 hover:text-white text-center inline-flex items-center justify-center gap-2"
            >
              <ExternalLinkIcon />
              View on Explorer
            </a>
          )}
          <button
            type="button"
            onClick={() => navigate("/app")}
            className="w-full rounded-xl bg-sol-gradient border border-transparent px-4 py-2.5 text-sm font-semibold text-white hover:opacity-90"
          >
            Return to App
          </button>
        </div>
      </div>
    </div>
  );
}
