import { useEffect, useState, useCallback } from "react";
import { NetworkValidationService } from "../../services/networkValidation";
import { useSecurityStore } from "../../store/securityStore";
import { getNetworkEnvValue } from "../../lib/chain";
import { NETWORK_PASSPHRASES, type StellarNetwork } from "../../lib/chain";

type WizardStep = 1 | 2 | 3;

const MISMATCH_REASONS = [
  {
    label: "Freighter set to wrong network",
    fix: "Open Freighter → Settings → Network → select the correct network.",
  },
  {
    label: "App .env changed without reload",
    fix: "After changing VITE_STELLAR_NETWORK, reload the page completely.",
  },
  {
    label: "Freighter not connected",
    fix: "Open Freighter and ensure it is unlocked and connected to this site.",
  },
];

function freighterSettingsUrl(): string {
  return "https://freighter.app";
}

export const NetworkMismatchModal: React.FC = () => {
  const { expectedNetwork } = useSecurityStore();
  const [actualNetwork, setActualNetwork] = useState<string | null>(null);
  const [mismatch, setMismatch] = useState(false);
  const [step, setStep] = useState<WizardStep>(1);
  const [retrying, setRetrying] = useState(false);
  const [retrySuccess, setRetrySuccess] = useState(false);

  const checkNetwork = useCallback(async () => {
    try {
      const validation = await NetworkValidationService.validateWalletContext();
      setMismatch(!validation.valid);
      setActualNetwork(validation.actual);
      if (validation.valid) {
        setStep(1);
        setRetrySuccess(false);
      }
      return validation.valid;
    } catch (e) {
      console.error(e);
      return false;
    }
  }, []);

  useEffect(() => {
    checkNetwork();
    const interval = setInterval(checkNetwork, 5000);
    return () => clearInterval(interval);
  }, [checkNetwork, expectedNetwork]);

  const handleNext = () => {
    if (step < 3) setStep((s) => (s + 1) as WizardStep);
  };

  const handleBack = () => {
    if (step > 1) setStep((s) => (s - 1) as WizardStep);
  };

  const handleRetry = async () => {
    setRetrying(true);
    const ok = await checkNetwork();
    if (ok) {
      setRetrySuccess(true);
      setTimeout(() => setRetrySuccess(false), 3000);
    }
    setRetrying(false);
  };

  if (!mismatch) return null;

  const appNetwork = getNetworkEnvValue();
  const expectedPassphrase = NETWORK_PASSPHRASES[expectedNetwork as StellarNetwork] ?? expectedNetwork;

  return (
    <div
      role="alertdialog"
      data-critical-modal
      data-security-warning
      className="fixed inset-0 bg-black/80 flex items-center justify-center z-[110] p-4"
    >
      <div className="bg-ink-900 text-white rounded-2xl p-6 max-w-md w-full shadow-2xl border border-ink-700">
        <div className="flex items-center gap-2 mb-2">
          <span className="flex h-2 w-2 rounded-full bg-neutral-500" aria-hidden />
          <span className="text-xs font-medium text-mist uppercase tracking-wider">
            Step {step} of 3
          </span>
        </div>

        {step === 1 && (
          <>
            <h2 className="text-xl font-bold mb-3">Network mismatch detected</h2>
            <p className="text-sm text-mist mb-4">
              Your Freighter wallet is connected to a different Stellar network than
              the application expects. Transactions will fail until this is resolved.
            </p>

            <div className="rounded-xl border border-ink-700 bg-ink-950 p-4 mb-5 space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-mist">App expects</span>
                <span className="font-mono font-medium text-white uppercase">{appNetwork}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-mist">Wallet has</span>
                <span className="font-mono font-medium text-neutral-500 uppercase">{actualNetwork || "Unknown"}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-mist">Expected passphrase</span>
                <span className="font-mono text-xs text-mist truncate ml-2">{expectedPassphrase}</span>
              </div>
            </div>

            <p className="text-sm font-medium text-white mb-3">Common causes:</p>
            <ul className="space-y-2 mb-5">
              {MISMATCH_REASONS.map((reason) => (
                <li key={reason.label} className="text-sm">
                  <span className="text-mist">— </span>
                  <span className="text-white font-medium">{reason.label}</span>
                  <p className="text-xs text-mist mt-0.5 ml-4">{reason.fix}</p>
                </li>
              ))}
            </ul>

            <button
              type="button"
              onClick={handleNext}
              className="w-full rounded-xl bg-sol-gradient border border-transparent px-4 py-2.5 text-sm font-semibold text-white hover:opacity-90 transition-opacity"
            >
              Show me how to fix it
            </button>
          </>
        )}

        {step === 2 && (
          <>
            <h2 className="text-xl font-bold mb-3">Switch Freighter network</h2>
            <div className="space-y-4 mb-5">
              <div className="rounded-xl border border-ink-700 bg-ink-950 p-4">
                <p className="text-sm font-medium text-white mb-2">
                  1. Open Freighter
                </p>
                <p className="text-xs text-mist">
                  Click the Freighter extension icon in your browser toolbar.
                </p>
              </div>
              <div className="rounded-xl border border-ink-700 bg-ink-950 p-4">
                <p className="text-sm font-medium text-white mb-2">
                  2. Go to Settings → Network
                </p>
                <p className="text-xs text-mist">
                  In the Freighter popup, open Settings (gear icon), then select
                  the Network tab.
                </p>
              </div>
              <div className="rounded-xl border border-ink-700 bg-ink-950 p-4">
                <p className="text-sm font-medium text-white mb-2">
                  3. Select <span className="uppercase font-mono text-neutral-500">{appNetwork}</span>
                </p>
                <p className="text-xs text-mist">
                  Choose <span className="uppercase font-mono">{appNetwork}</span> from the dropdown.
                  If using a custom RPC, ensure the network passphrase matches:
                </p>
                <p className="text-xs font-mono text-mist mt-1 truncate">
                  {expectedPassphrase}
                </p>
              </div>
            </div>

            <a
              href={freighterSettingsUrl()}
              target="_blank"
              rel="noopener noreferrer"
              className="block w-full rounded-xl border border-ink-600 bg-ink-950/30 px-4 py-2.5 text-sm font-medium text-center text-mist hover:border-white/30 hover:text-white transition-colors mb-3"
            >
              Open Freighter website
            </a>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleBack}
                className="flex-1 rounded-xl border border-ink-600 bg-ink-950/30 px-4 py-2.5 text-sm font-medium text-mist hover:border-white/30 hover:text-white transition-colors"
              >
                Back
              </button>
              <button
                type="button"
                onClick={handleNext}
                className="flex-1 rounded-xl bg-sol-gradient border border-transparent px-4 py-2.5 text-sm font-semibold text-white hover:opacity-90 transition-opacity"
              >
                Done, check again
              </button>
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <h2 className="text-xl font-bold mb-3">Verify connection</h2>
            <p className="text-sm text-mist mb-4">
              Click below to re-check your wallet network. If the networks still
              don't match, go back to step 2 and double-check your Freighter settings.
            </p>

            {retrySuccess && (
              <div className="rounded-xl border border-green-700 bg-green-950/30 p-4 mb-4 text-center">
                <p className="text-sm font-medium text-green-400">Network aligned!</p>
                <p className="text-xs text-green-400/70 mt-1">
                  Your wallet is now on the correct network.
                </p>
              </div>
            )}

            <div className="rounded-xl border border-ink-700 bg-ink-950 p-4 mb-5">
              <div className="flex justify-between text-sm mb-1">
                <span className="text-mist">App expects</span>
                <span className="font-mono font-medium text-white uppercase">{appNetwork}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-mist">Wallet has</span>
                <span className="font-mono font-medium text-neutral-500 uppercase">{actualNetwork || "Unknown"}</span>
              </div>
            </div>

            <button
              type="button"
              onClick={handleRetry}
              disabled={retrying}
              className="w-full rounded-xl bg-sol-gradient border border-transparent px-4 py-2.5 text-sm font-semibold text-white hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed mb-2"
            >
              {retrying ? "Checking…" : "Retry connection check"}
            </button>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleBack}
                className="flex-1 rounded-xl border border-ink-600 bg-ink-950/30 px-4 py-2 text-sm font-medium text-mist hover:border-white/30 hover:text-white transition-colors"
              >
                Back
              </button>
              <button
                type="button"
                onClick={() => setStep(1)}
                className="flex-1 rounded-xl border border-ink-600 bg-ink-950/30 px-4 py-2 text-sm font-medium text-mist hover:border-white/30 hover:text-white transition-colors"
              >
                Start over
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
