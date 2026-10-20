import { ModalShell } from "./ModalShell";
import { ExplorerLink } from "./ExplorerLink";
import { formatXlm } from "../lib/stealth";
import { getDocUrl } from "../lib/docsLinks";
import type { VerifiedBid } from "../lib/relayerMarket";

export type WithdrawStepStatus = "pending" | "active" | "done" | "error";

export type WithdrawStep = {
  id: string;
  title: string;
  detail: string;
  status: WithdrawStepStatus;
  /** Short technical note shown under the step once it has run (e.g. a tx hash). */
  note?: string;
};

type WithdrawFlowModalProps = {
  open: boolean;
  mode: "wallet" | "relayer";
  steps: WithdrawStep[];
  /** Any async work is currently running (drives spinners + disables actions). */
  busy: boolean;
  error: string | null;
  done: boolean;
  successHash: string | null;
  successText: string | null;
  cluster: string | null;

  /** Relayer pick stage. */
  awaitingRelayerPick: boolean;
  bids: VerifiedBid[];
  selectedRelayer: string | null;
  onSelectRelayer: (operator: string) => void;
  onPickForMe: () => void;
  onRefreshBids: () => void;
  onAssign: () => void;

  /** Escrow recovery (a relayer job is on-chain but unresolved). */
  draftActive: boolean;
  /** Cancels the in-browser proof while its prove step is running (#1131). */
  onCancelProof?: () => void;
  onCancelJob: () => void;
  onSlashJob: () => void;

  /** Set once the assigned relayer has blown past the stall threshold (#616). */
  stalledRelayer: { operator: string; jobId: string } | null;
  /** Whether a different verified bid exists to fall back to right now. */
  canResubmitElsewhere: boolean;
  onResubmitElsewhere: () => void;

  onClose: () => void;
};

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function StepDot({ index, status, spinning }: { index: number; status: WithdrawStepStatus; spinning: boolean }) {
  if (status === "done") {
    return (
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-success/50 bg-success/10 text-success">
        <CheckIcon />
      </div>
    );
  }
  if (status === "error") {
    return (
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-error/50 bg-error/10 text-error">
        <XIcon />
      </div>
    );
  }
  const active = status === "active";
  return (
    <div
      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold transition-colors ${
        active ? "border-glow bg-glow/10 text-glow" : "border-ink-600 bg-ink-950 text-mist/50"
      }`}
    >
      {spinning ? (
        <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-glow/30 border-t-glow" aria-hidden />
      ) : (
        index
      )}
    </div>
  );
}

export function WithdrawFlowModal(props: WithdrawFlowModalProps) {
  const {
    open,
    mode,
    steps,
    busy,
    error,
    done,
    successHash,
    successText,
    cluster,
    awaitingRelayerPick,
    bids,
    selectedRelayer,
    onSelectRelayer,
    onPickForMe,
    onRefreshBids,
    onAssign,
    draftActive,
    onCancelProof,
    onCancelJob,
    onSlashJob,
    stalledRelayer,
    canResubmitElsewhere,
    onResubmitElsewhere,
    onClose,
  } = props;

  const title = mode === "wallet" ? "Withdraw — connected wallet" : "Withdraw — relayer market";
  const description =
    mode === "wallet"
      ? "A zero-knowledge proof lets you withdraw without revealing which deposit is yours."
      : "A relayer submits the withdrawal for you, so the withdrawal transaction is not sent from your wallet. Your wallet still signs the escrow job, which can reveal timing.";

  // Recovery is only meaningful when a job is escrowed but the flow isn't finished.
  const showRecovery = mode === "relayer" && draftActive && !done;
  // Cancelling only makes sense while the browser is generating the proof, not while signing or submitting.
  const proving = steps.some((step) => step.id === "prove" && step.status === "active");

  return (
    <ModalShell
      open={open}
      title={title}
      description={description}
      onClose={onClose}
      closeOnBackdrop={!busy}
      maxWidthClassName="max-w-lg"
    >
      <ol className="relative max-h-[52vh] overflow-y-auto pr-1">
        {steps.map((step, i) => {
          const isLast = i === steps.length - 1;
          const dim = step.status === "pending";
          const isPickStage = step.id === "pick" && awaitingRelayerPick;
          return (
            <li key={step.id} className="flex gap-3">
              <div className="flex flex-col items-center">
                <StepDot index={i + 1} status={step.status} spinning={step.status === "active" && busy} />
                {!isLast && (
                  <div
                    className={`my-1 w-px flex-1 transition-colors ${
                      step.status === "done" ? "bg-success/40" : "bg-ink-700"
                    }`}
                  />
                )}
              </div>
              <div className={`flex-1 ${isLast ? "pb-1" : "pb-4"}`}>
                <div className={`text-sm font-medium ${dim ? "text-mist/50" : "text-white"}`}>{step.title}</div>
                <div className={`mt-0.5 text-xs leading-relaxed ${dim ? "text-mist/40" : "text-mist/80"}`}>
                  {step.detail}
                </div>
                {step.note && (
                  <div className="mt-1 break-all font-mono text-[11px] text-glow/80">{step.note}</div>
                )}

                {isPickStage && (
                  <div className="mt-3 space-y-2 rounded-xl border border-ink-700 bg-ink-950/60 p-3">
                    {bids.length === 0 ? (
                      <p className="text-xs text-warning">
                        No verified bids yet. Give relayers a moment, then refresh.
                      </p>
                    ) : (
                      bids.map((bid) => (
                        <label
                          key={bid.operator}
                          className={`flex cursor-pointer items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm transition-colors ${
                            selectedRelayer === bid.operator
                              ? "border-glow bg-black/30 text-white"
                              : "border-ink-700 text-mist hover:border-white/30"
                          }`}
                        >
                          <span className="flex min-w-0 items-center gap-2">
                            <input
                              type="radio"
                              name="relayer-bid"
                              checked={selectedRelayer === bid.operator}
                              onChange={() => onSelectRelayer(bid.operator)}
                              disabled={busy}
                              className="accent-glow"
                            />
                            <span className="truncate font-mono text-xs">
                              {bid.operator.slice(0, 8)}…{bid.operator.slice(-6)}
                            </span>
                          </span>
                          <span className="shrink-0 text-xs text-mist/60">
                            free {formatXlm(bid.freeStakeValue)} XLM
                          </span>
                        </label>
                      ))
                    )}
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={onPickForMe}
                        disabled={busy || bids.length === 0}
                        className="min-h-9 flex-1 rounded-lg border border-ink-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:border-glow hover:text-glow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-glow disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        Pick for me (stake-weighted)
                      </button>
                      <button
                        type="button"
                        onClick={onRefreshBids}
                        disabled={busy}
                        className="min-h-9 rounded-lg border border-ink-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:border-glow hover:text-glow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-glow disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        Refresh
                      </button>
                    </div>
                    <button
                      type="button"
                      onClick={onAssign}
                      disabled={busy || !selectedRelayer}
                      className="min-h-10 w-full rounded-lg bg-glow px-4 py-2 text-sm font-semibold text-ink-950 transition-colors hover:bg-[#ffe24f] disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Assign relayer &amp; withdraw
                    </button>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      <p className="mt-3 text-xs leading-relaxed text-mist/60">
        Proof transactions still reveal public inputs and timing.{" "}
        <a
          href={getDocUrl("proof-submission-privacy")}
          target="_blank"
          rel="noreferrer"
          className="text-glow underline-offset-4 hover:underline"
        >
          Review submission privacy
        </a>
        .
      </p>

      {error && (
        <div className="mt-2 rounded-xl border border-error/30 bg-error/10 p-3 text-sm text-error">{error}</div>
      )}

      {done && (
        <div className="mt-2 rounded-xl border border-success/30 bg-success/10 p-3 text-sm text-success">
          <p className="font-medium">{successText ?? "Withdrawal complete."}</p>
          {successHash && (
            <div className="mt-1.5 text-xs">
              <ExplorerLink cluster={cluster} value={successHash} type="tx" className="text-success" />
            </div>
          )}
        </div>
      )}

      {stalledRelayer && (
        <div className="mt-4 rounded-xl border border-warning/40 bg-warning/10 p-3">
          <p className="text-xs font-medium text-warning">Possible censorship detected</p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-mist/70">
            {stalledRelayer.operator.slice(0, 8)}…{stalledRelayer.operator.slice(-6)} accepted your job but hasn't
            submitted it. It's been noted on this device so future picks avoid it. Resubmitting re-proves the fee
            binding for a different relayer and escrows a fresh job.
          </p>
          <button
            type="button"
            onClick={onResubmitElsewhere}
            disabled={busy || !canResubmitElsewhere}
            className="mt-2 min-h-9 w-full rounded-lg bg-glow px-3 py-1.5 text-xs font-semibold text-ink-950 transition-colors hover:bg-[#ffe24f] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {canResubmitElsewhere ? "Re-prove & resubmit via another relayer" : "No alternate relayer available yet"}
          </button>
        </div>
      )}

      {showRecovery && (
        <div className="mt-4 rounded-xl border border-ink-700 bg-ink-950/40 p-3">
          <p className="text-xs font-medium text-mist/80">Relayer not responding?</p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-mist/50">
            Your fee is escrowed on-chain. If the job expires unaccepted you can cancel it; if a relayer accepted but
            never submitted, slash it. Either way the escrow is refunded.
          </p>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={onCancelJob}
              disabled={busy}
              className="min-h-9 rounded-lg border border-ink-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:border-glow hover:text-glow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-glow disabled:cursor-not-allowed disabled:opacity-40"
            >
              Cancel expired job
            </button>
            <button
              type="button"
              onClick={onSlashJob}
              disabled={busy}
              className="min-h-9 rounded-lg border border-ink-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:border-glow hover:text-glow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-glow disabled:cursor-not-allowed disabled:opacity-40"
            >
              Slash failed relayer
            </button>
          </div>
        </div>
      )}

      <div className="mt-5 flex justify-end gap-2">
        {proving && onCancelProof && (
          <button
            type="button"
            onClick={onCancelProof}
            className="min-h-10 rounded-xl border border-ink-600 px-4 py-2 text-sm font-medium text-mist transition-colors hover:border-white/40 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-glow"
          >
            Cancel proof
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          className={`min-h-10 rounded-xl px-4 py-2 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-glow disabled:cursor-not-allowed disabled:opacity-40 ${
            done
              ? "bg-glow text-ink-950 hover:bg-[#ffe24f]"
              : "border border-ink-600 text-mist hover:border-white/40 hover:text-white"
          }`}
        >
          {done ? "Done" : busy ? "Working…" : "Close"}
        </button>
      </div>
    </ModalShell>
  );
}

