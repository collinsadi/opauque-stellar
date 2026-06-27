import { useState, useEffect } from "react";
import {
  fetchSep10Challenge,
  verifySep10Challenge,
  storeSep10Session,
  getSep10Session,
  clearSep10Session,
  isSep10SessionValid,
  type Sep10Session,
} from "../lib/sep10";
import { useWallet } from "../hooks/useWallet";

type Step = "idle" | "fetching" | "signing" | "verifying" | "done" | "error";

const TESTNET_DEMO_SERVER = "https://testanchor.stellar.org";

type Sep10AuthViewProps = {
  onBack: () => void;
};

export function Sep10AuthView({ onBack }: Sep10AuthViewProps) {
  const { publicKey, signTransaction, connected } = useWallet();

  const [serverUrl, setServerUrl] = useState(TESTNET_DEMO_SERVER);
  const [step, setStep] = useState<Step>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [session, setSession] = useState<Sep10Session | null>(null);

  // Restore any stored session on mount / server change.
  useEffect(() => {
    const stored = getSep10Session(serverUrl.trim());
    setSession(stored);
    setStep("idle");
    setErrorMsg(null);
  }, [serverUrl]);

  const handleAuthenticate = async () => {
    if (!publicKey || !signTransaction) {
      setErrorMsg("Connect your wallet first.");
      return;
    }
    const url = serverUrl.trim();
    if (!url) {
      setErrorMsg("Enter a SEP-10 server URL.");
      return;
    }

    setErrorMsg(null);
    setStep("fetching");

    try {
      // Step 1 — fetch challenge
      const challenge = await fetchSep10Challenge(url, publicKey);

      // Step 2 — sign with wallet
      setStep("signing");
      const signedXdr = await signTransaction(challenge.transaction);

      // Step 3 — verify
      setStep("verifying");
      const newSession = await verifySep10Challenge(url, signedXdr, publicKey);
      storeSep10Session(newSession);
      setSession(newSession);
      setStep("done");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Authentication failed.");
      setStep("error");
    }
  };

  const handleClear = () => {
    clearSep10Session(serverUrl.trim());
    setSession(null);
    setStep("idle");
    setErrorMsg(null);
  };

  const sessionValid = session ? isSep10SessionValid(session) : false;

  const stepLabel: Record<Step, string> = {
    idle: "Authenticate",
    fetching: "Fetching challenge…",
    signing: "Awaiting wallet signature…",
    verifying: "Verifying with server…",
    done: "Authenticated",
    error: "Retry",
  };

  return (
    <div className="w-full max-w-lg mx-auto">
      <h2 className="text-lg font-semibold text-white mb-1">SEP-10 Web Authentication</h2>
      <p className="text-sm text-neutral-500 mb-6">
        Establish an authenticated session with a Stellar anchor server. The
        signed challenge proves wallet ownership without replacing Freighter for
        transaction signing.
      </p>

      <div className="mb-4">
        <label className="block text-sm text-neutral-400 mb-1.5">Anchor server URL</label>
        <input
          type="url"
          value={serverUrl}
          onChange={(e) => setServerUrl(e.target.value)}
          placeholder="https://testanchor.stellar.org"
          className="w-full rounded-lg bg-neutral-900 border border-neutral-700 px-3 py-2 text-sm text-white"
          disabled={step === "fetching" || step === "signing" || step === "verifying"}
        />
        <p className="text-xs text-neutral-500 mt-1">
          The server must expose a <code className="font-mono text-neutral-400">/auth</code> endpoint
          implementing SEP-10.
        </p>
      </div>

      {publicKey && (
        <div className="mb-4 rounded-xl border border-neutral-700/50 bg-neutral-900/60 px-4 py-3">
          <p className="text-xs text-neutral-400 mb-1">Authenticating as</p>
          <p className="text-sm font-mono text-white break-all">{publicKey}</p>
        </div>
      )}

      {session && sessionValid && (
        <div className="mb-4 rounded-xl border border-green-600/30 bg-green-900/10 px-4 py-3">
          <p className="text-xs text-green-400 mb-1 font-medium">Session active</p>
          <p className="text-xs font-mono text-neutral-300 break-all">
            {session.token.slice(0, 40)}…
          </p>
          {session.expiresAt && (
            <p className="text-xs text-neutral-500 mt-1">
              Expires: {new Date(session.expiresAt * 1000).toLocaleString()}
            </p>
          )}
        </div>
      )}

      {session && !sessionValid && (
        <div className="mb-4 rounded-xl border border-yellow-600/30 bg-yellow-900/10 px-4 py-3">
          <p className="text-xs text-yellow-400 font-medium">Session expired — re-authenticate to continue.</p>
        </div>
      )}

      {errorMsg && (
        <p className="text-sm text-neutral-400 mb-4">{errorMsg}</p>
      )}

      {!connected && (
        <p className="text-sm text-neutral-500 mb-4">Connect your wallet to authenticate.</p>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => void handleAuthenticate()}
          disabled={
            !connected ||
            step === "fetching" ||
            step === "signing" ||
            step === "verifying"
          }
          className="py-2.5 px-4 rounded-lg text-sm font-medium btn-primary disabled:opacity-40"
        >
          {stepLabel[step]}
        </button>

        {session && (
          <button
            type="button"
            onClick={handleClear}
            className="py-2.5 px-4 rounded-lg text-sm btn-secondary"
          >
            Clear session
          </button>
        )}

        <button
          type="button"
          onClick={onBack}
          className="py-2.5 px-4 rounded-lg text-sm btn-secondary"
        >
          Back
        </button>
      </div>
    </div>
  );
}
