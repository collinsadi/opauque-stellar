import { useNavigate } from "react-router-dom";
import { useOnlineStatus } from "../hooks/useOnlineStatus";
import { useOfflineQueueStore } from "../store/offlineQueueStore";

export function OfflineQueueBanner() {
  const online = useOnlineStatus();
  const navigate = useNavigate();
  const intents = useOfflineQueueStore((s) => s.intents);
  const remove = useOfflineQueueStore((s) => s.remove);

  if (!online) {
    return (
      <div className="fixed left-4 right-4 top-4 z-[80] md:left-1/2 md:right-auto md:top-24 md:w-[28rem] md:-translate-x-1/2">
        <div className="rounded-xl border border-warning/40 bg-ink-900/95 px-4 py-3 text-sm text-white shadow-2xl backdrop-blur-lg">
          <p className="font-semibold">Offline mode</p>
          <p className="mt-1 text-xs text-mist">
            Network actions will be saved before signing and retried only after you confirm.
          </p>
        </div>
      </div>
    );
  }

  if (intents.length === 0) return null;

  const next = intents[0];
  const label =
    next.type === "send"
      ? `Send ${next.amount} XLM`
      : "Rescan reputation proofs";

  const handleRetry = () => {
    const confirmed = window.confirm(
      "Retry this queued action now? You will still review it before any wallet submission.",
    );
    if (!confirmed) return;

    if (next.type === "send") {
      navigate("/app", {
        state: {
          tab: "send",
          sendPrefill: {
            recipient: next.recipient,
            amount: next.amount,
            queuedIntentId: next.id,
          },
        },
      });
      return;
    }

    remove(next.id);
    navigate("/app", {
      state: {
        tab: "reputation",
        retryOfflineScan: true,
      },
    });
  };

  return (
    <div className="fixed left-4 right-4 top-4 z-[80] md:left-1/2 md:right-auto md:top-24 md:w-[30rem] md:-translate-x-1/2">
      <div className="rounded-xl border border-ink-700 bg-ink-900/95 px-4 py-3 text-sm text-white shadow-2xl backdrop-blur-lg">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="font-semibold">Queued action ready</p>
            <p className="mt-1 truncate text-xs text-mist">
              {label}
              {intents.length > 1 ? ` and ${intents.length - 1} more` : ""}
            </p>
          </div>
          <button
            type="button"
            onClick={handleRetry}
            className="rounded-lg border border-ink-600 bg-ink-800 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:border-white/40 hover:bg-ink-700"
          >
            Retry
          </button>
        </div>
      </div>
    </div>
  );
}
