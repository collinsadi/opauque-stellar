import { useState } from "react";
import { isFederationIdentifier, resolveDomain, isFederationSupportedForNetwork } from "../lib/ens";
import { getNetwork } from "../lib/chain";

type SubENSViewProps = {
  onBack: () => void;
};

const SUBENS_STORAGE_KEY = "opaque-subens-name";

function getStoredName(): string | null {
  try {
    return localStorage.getItem(SUBENS_STORAGE_KEY);
  } catch {
    return null;
  }
}

function setStoredName(name: string) {
  try {
    localStorage.setItem(SUBENS_STORAGE_KEY, name);
  } catch {
    // ignore
  }
}

export function SubENSView({ onBack }: SubENSViewProps) {
  const [input, setInput] = useState(getStoredName() ?? "");
  const [resolving, setResolving] = useState(false);
  const [resolvedAddress, setResolvedAddress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const network = getNetwork();
  const federationSupported = isFederationSupportedForNetwork(network);

  const handleLookup = async () => {
    const trimmed = input.trim();
    if (!trimmed) return;

    if (!isFederationIdentifier(trimmed)) {
      setError("Enter a federation identifier (name*domain.com).");
      setResolvedAddress(null);
      return;
    }

    setResolving(true);
    setError(null);
    setResolvedAddress(null);

    try {
      const address = await resolveDomain(trimmed);
      if (address) {
        setResolvedAddress(address);
        setStoredName(trimmed);
      } else {
        setError("Federation lookup returned no address for this identifier.");
      }
    } catch {
      setError("Federation lookup failed. The server may be unreachable.");
    } finally {
      setResolving(false);
    }
  };

  if (!federationSupported) {
    return (
      <div className="w-full max-w-lg mx-auto">
        <h2 className="text-lg font-semibold text-white mb-1">Federation / Identifier Lookup</h2>
        <p className="text-sm text-neutral-500 mb-6">
          Resolve Stellar federation identifiers (name*domain.com) to addresses.
        </p>
        <div className="rounded-2xl border border-neutral-500/30 bg-neutral-500/10 px-5 py-4 text-sm">
          <p className="font-semibold text-neutral-300">Federation not available on {network}</p>
          <p className="mt-2 text-neutral-300/80 text-xs leading-relaxed">
            Federation servers are only available on <strong>mainnet</strong> and{" "}
            <strong>testnet</strong>. Switch to a supported network to look up
            federation identifiers.
          </p>
        </div>
        <button
          type="button"
          onClick={onBack}
          className="mt-4 py-2.5 px-4 rounded-lg text-sm btn-secondary"
        >
          Back
        </button>
      </div>
    );
  }

  return (
    <div className="w-full max-w-lg mx-auto">
      <h2 className="text-lg font-semibold text-white mb-1">Federation Lookup</h2>
      <p className="text-sm text-neutral-500 mb-6">
        Resolve a Stellar federation identifier (name*domain.com) to an on-chain address.
      </p>
      <div className="mb-4">
        <label className="block text-sm text-neutral-500 mb-1.5">Identifier</label>
        <input
          type="text"
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setError(null);
            setResolvedAddress(null);
          }}
          placeholder="yourname*domain.com"
          className="input-field"
        />
        {input.trim() && isFederationIdentifier(input.trim()) && (
          <p className="mt-1.5 text-neutral-500 text-xs font-mono">
            → Resolving federation identifier
          </p>
        )}
      </div>

      {error && (
        <p className="text-sm text-neutral-400 mb-4">{error}</p>
      )}

      {resolvedAddress && (
        <div className="rounded-xl border border-neutral-500/30 bg-neutral-500/10 px-4 py-3 mb-4">
          <p className="text-xs text-neutral-400 mb-1">Resolved Address</p>
          <p className="text-sm font-mono text-white break-all">{resolvedAddress}</p>
        </div>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => void handleLookup()}
          disabled={resolving || !input.trim()}
          className="py-2.5 px-4 rounded-lg text-sm font-medium btn-primary disabled:opacity-40"
        >
          {resolving ? "Resolving…" : "Look Up"}
        </button>
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
