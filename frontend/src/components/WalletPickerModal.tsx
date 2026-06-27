import { ALL_WALLET_ADAPTERS, type WalletAdapter } from "../lib/walletAdapters";

type WalletPickerModalProps = {
  open: boolean;
  onSelect: (adapter: WalletAdapter) => void;
  onClose: () => void;
  connecting?: boolean;
  connectingId?: string;
  error?: string | null;
};

export function WalletPickerModal({
  open,
  onSelect,
  onClose,
  connecting = false,
  connectingId,
  error,
}: WalletPickerModalProps) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-sm rounded-2xl border border-neutral-700 bg-neutral-950 p-6 shadow-2xl">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-base font-semibold text-white">Connect wallet</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-neutral-500 hover:text-white transition-colors text-xl leading-none"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <p className="text-xs text-neutral-500 mb-4">
          Freighter is recommended. Other wallets connect via their browser
          extension if installed.
        </p>

        <div className="space-y-2">
          {ALL_WALLET_ADAPTERS.map((adapter) => {
            const available = adapter.isAvailable();
            const isConnecting = connecting && connectingId === adapter.id;
            return (
              <button
                key={adapter.id}
                type="button"
                onClick={() => available && onSelect(adapter)}
                disabled={connecting}
                className={`w-full flex items-center justify-between px-4 py-3 rounded-xl border text-sm transition-colors ${
                  available
                    ? "border-neutral-700 text-white hover:border-neutral-500 hover:bg-neutral-800/60 cursor-pointer"
                    : "border-neutral-800 text-neutral-600 cursor-default"
                } disabled:opacity-60`}
              >
                <span className="font-medium">
                  {adapter.name}
                  {adapter.id === "freighter" && (
                    <span className="ml-2 text-xs text-neutral-500 font-normal">Recommended</span>
                  )}
                </span>
                {isConnecting ? (
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-neutral-600 border-t-white" />
                ) : available ? (
                  <span className="text-xs text-green-400">Detected</span>
                ) : (
                  <a
                    href={adapter.installUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-neutral-500 hover:text-neutral-300 underline"
                    onClick={(e) => e.stopPropagation()}
                  >
                    Install
                  </a>
                )}
              </button>
            );
          })}
        </div>

        {error && (
          <p className="mt-4 text-sm text-neutral-400">{error}</p>
        )}
      </div>
    </div>
  );
}
