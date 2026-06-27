import { useState } from "react";
import type { Tab } from "./Layout";
import { SubENSView } from "./SubENSView";
import { Sep10AuthView } from "./Sep10AuthView";
import { useWallet } from "../hooks/useWallet";
import { ALL_WALLET_ADAPTERS } from "../lib/walletAdapters";

type ProfileViewProps = {
  onNavigate: (t: Tab) => void;
  onDisconnect: () => void;
};

type Subview = "main" | "federation" | "sep10";

export function ProfileView({ onNavigate: _onNavigate, onDisconnect }: ProfileViewProps) {
  const [subview, setSubview] = useState<Subview>("main");
  const { activeWalletId, publicKey } = useWallet();

  if (subview === "federation") {
    return <SubENSView onBack={() => setSubview("main")} />;
  }

  if (subview === "sep10") {
    return <Sep10AuthView onBack={() => setSubview("main")} />;
  }

  const activeAdapter = ALL_WALLET_ADAPTERS.find((a) => a.id === activeWalletId);

  return (
    <div className="w-full max-w-lg mx-auto">
      <h2 className="text-lg font-semibold text-white mb-1">Profile</h2>
      <p className="text-sm text-neutral-500 mb-6">
        Identity and session.
      </p>

      {publicKey && (
        <div className="mb-6 rounded-xl border border-neutral-700/50 bg-neutral-900/60 px-4 py-3">
          <p className="text-xs text-neutral-400 mb-1">Connected wallet</p>
          <p className="text-sm font-mono text-white break-all">{publicKey}</p>
          {activeAdapter && (
            <p className="text-xs text-neutral-500 mt-1">via {activeAdapter.name}</p>
          )}
        </div>
      )}

      <div className="space-y-3">
        <button
          type="button"
          onClick={() => setSubview("federation")}
          className="w-full py-2.5 px-4 rounded-lg text-sm font-medium border border-neutral-700 text-neutral-300 hover:border-neutral-500 hover:text-white transition-colors text-left"
        >
          Federation lookup
          <span className="block text-xs text-neutral-500 font-normal mt-0.5">
            Resolve name*domain.com to a Stellar address
          </span>
        </button>

        <button
          type="button"
          onClick={() => setSubview("sep10")}
          className="w-full py-2.5 px-4 rounded-lg text-sm font-medium border border-neutral-700 text-neutral-300 hover:border-neutral-500 hover:text-white transition-colors text-left"
        >
          SEP-10 web authentication
          <span className="block text-xs text-neutral-500 font-normal mt-0.5">
            Establish a session with a Stellar anchor server
          </span>
        </button>

        <button
          type="button"
          onClick={onDisconnect}
          className="w-full py-2.5 px-4 rounded-lg text-sm font-medium border border-error/40 text-error hover:bg-error/10 transition-colors"
        >
          Disconnect Wallet
        </button>
      </div>
    </div>
  );
}
