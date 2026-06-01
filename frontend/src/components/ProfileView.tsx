import type { Tab } from "./Layout";
import { PERSIST_ON_DISCONNECT } from "../lib/localDataManager";

type ProfileViewProps = {
  onNavigate: (t: Tab) => void;
  onDisconnect: () => void;
};

export function ProfileView({ onNavigate, onDisconnect }: ProfileViewProps) {
  return (
    <div className="w-full max-w-lg mx-auto">
      <h2 className="text-lg font-semibold text-white mb-1">Profile</h2>
      <p className="text-sm text-neutral-500 mb-4">
        Identity and session.
      </p>
      <p className="text-xs text-mist mb-4 leading-relaxed">
        Disconnect clears in-memory master keys and the vault. These stay on this device:{" "}
        {PERSIST_ON_DISCONNECT.slice(0, 2).join(", ")}… Use Security settings to wipe all local data.
      </p>
      <div className="space-y-3">
        <button
          type="button"
          onClick={() => onNavigate("security" as Tab)}
          className="w-full py-2.5 px-4 rounded-lg text-sm font-medium border border-ink-600 text-mist hover:text-white hover:border-sol-purple/30 transition-colors"
        >
          Security & clear local data
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
