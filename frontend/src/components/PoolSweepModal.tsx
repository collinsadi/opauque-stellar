import { useCallback, useEffect, useMemo, useState } from "react";
import {
  deriveStealthStellarAddressFromStealthPrivKey,
  formatXlm,
  hexToBytes,
} from "../lib/stealth";
import { ModalShell } from "./ModalShell";
import { ExplorerLink } from "./ExplorerLink";
import { getDocUrl } from "../lib/docsLinks";
import {
  MIN_DEPOSIT_STROOPS,
  planPoolSweep,
  presetChunkStroops,
  quoteStealthSpendable,
  sweepStealthIntoPool,
  type PoolSweepPlan,
  type PoolSweepResult,
} from "../lib/poolSweep";
import { getPoolConfig } from "../contracts/poolConfig";
import type { FoundTx } from "./PrivateBalanceView";

type PoolSweepModalProps = {
  tx: FoundTx;
  cluster: string | null;
  onClose: () => void;
  onSwept: (result: PoolSweepResult) => void;
};

export function PoolSweepModal({ tx, cluster, onClose, onSwept }: PoolSweepModalProps) {
  const [quote, setQuote] = useState<{
    spendableStroops: bigint;
    minimumBalanceStroops: bigint;
  } | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  // Chunk size in stroops, always one of the deployment's deposit presets. `null` = not chosen yet.
  const [chunkChoice, setChunkChoice] = useState<bigint | null>(null);
  const presetChunks = useMemo(
    () => presetChunkStroops(getPoolConfig()?.depositPresetsXlm ?? []),
    [],
  );
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ index: number; count: number } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  const stealthStellarAddress = useMemo(() => {
    if (tx.stealthStellarAddress) return tx.stealthStellarAddress;
    if (tx.privateKey) {
      try {
        return deriveStealthStellarAddressFromStealthPrivKey(
          hexToBytes(tx.privateKey as `0x${string}`),
        );
      } catch {
        return undefined;
      }
    }
    return undefined;
  }, [tx.stealthStellarAddress, tx.privateKey]);

  useEffect(() => {
    if (!stealthStellarAddress) {
      setQuoteError("Cannot read this stealth account.");
      return;
    }
    let cancelled = false;
    setQuote(null);
    setQuoteError(null);
    quoteStealthSpendable(stealthStellarAddress)
      .then((q) => {
        if (!cancelled) setQuote(q);
      })
      .catch((e) => {
        if (!cancelled)
          setQuoteError(e instanceof Error ? e.message : "Could not read balance.");
      });
    return () => {
      cancelled = true;
    };
  }, [stealthStellarAddress]);

  const plan: PoolSweepPlan | null = useMemo(() => {
    if (!quote || chunkChoice == null) return null;
    return planPoolSweep({
      spendableStroops: quote.spendableStroops,
      minimumBalanceStroops: quote.minimumBalanceStroops,
      chunkStroops: chunkChoice,
    });
  }, [quote, chunkChoice]);

  // A preset is only offered as a choice when this balance can fill at least one note of it.
  const presetFits = useMemo(() => {
    const fits = new Map<bigint, boolean>();
    if (!quote) return fits;
    for (const stroops of presetChunks) {
      const probe = planPoolSweep({
        spendableStroops: quote.spendableStroops,
        minimumBalanceStroops: quote.minimumBalanceStroops,
        chunkStroops: stroops,
      });
      fits.set(stroops, probe.chunkCount >= 1);
    }
    return fits;
  }, [quote, presetChunks]);

  const canDeposit = !!plan && plan.chunkCount >= 1 && plan.chunkStroops >= MIN_DEPOSIT_STROOPS;

  const handleConfirm = useCallback(async () => {
    if (!plan || !canDeposit || !tx.privateKey || cluster == null) return;
    setBusy(true);
    setError(null);
    setProgress({ index: 0, count: plan.chunkCount });
    try {
      const result = await sweepStealthIntoPool({
        stealthPrivKeyHex: tx.privateKey,
        cluster,
        plan,
        onProgress: (e) => {
          if (e.phase === "depositing")
            setProgress({ index: e.chunkIndex, count: e.chunkCount });
        },
      });
      onSwept(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Pool deposit failed.");
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }, [plan, canDeposit, tx.privateKey, cluster, onSwept]);

  return (
    <ModalShell
      open
      title="Move to privacy pool"
      description="Deposit this stealth balance into the pool. Your connected wallet is never involved; the funds withdraw unlinkably later."
      onClose={onClose}
      closeOnBackdrop={!busy}
      maxWidthClassName="max-w-md"
    >
      <div className="mb-4 p-3 rounded-xl bg-ink-950/40 border border-ink-700 font-mono text-xs text-mist">
        <div className="flex justify-between items-center gap-2">
          <ExplorerLink
            cluster={cluster}
            value={stealthStellarAddress ?? tx.address}
            type="address"
            className="text-slate-200"
          />
          <span className="text-success font-medium shrink-0">
            {formatXlm(tx.balance)} XLM
          </span>
        </div>
      </div>

      <div className="space-y-1.5 mb-5 p-3 rounded-xl bg-ink-950/30 border border-ink-700 font-mono text-xs text-mist/90">
        <p className="text-slate-200 font-medium">Spendable into pool</p>
        {quoteError ? (
          <p className="text-warning">{quoteError}</p>
        ) : !quote ? (
          <p>Reading stealth balance…</p>
        ) : (
          <div className="flex justify-between gap-3">
            <span>Available</span>
            <span className="text-success">
              {formatXlm(quote.spendableStroops)} XLM
            </span>
          </div>
        )}
      </div>

      {/* Chunking choice */}
      <div className="mb-4">
        <label className="block text-sm text-mist mb-1.5 font-mono">Deposit style</label>
        {presetChunks.length === 0 ? (
          <p className="text-xs text-warning">
            This deployment publishes no deposit presets, so sweeps are unavailable.
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {presetChunks.map((stroops) => {
              const selected = chunkChoice === stroops;
              const fits = presetFits.get(stroops) ?? false;
              return (
                <button
                  key={stroops.toString()}
                  type="button"
                  disabled={busy || !fits}
                  onClick={() => setChunkChoice(stroops)}
                  className={`rounded-xl border px-3 py-2 text-xs font-medium transition-colors disabled:opacity-40 ${
                    selected
                      ? "border-glow bg-black/30 text-white"
                      : "border-ink-700 text-mist hover:border-white/30"
                  }`}
                >
                  {formatXlm(stroops)} XLM notes
                  {quote && !fits && <span className="block text-[10px] text-mist/60">balance too small</span>}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Privacy advice */}
      <div className="mb-5 p-3 rounded-xl bg-ink-950/40 border border-glow/20 text-sm text-mist/90">
        <p className="text-glow font-medium">Why deposit in chunks?</p>
        <p className="mt-1 text-xs leading-relaxed">
          Equal-size deposits grow your withdrawal anonymity set: a note blends with
          every other note of the same size instead of being fingerprinted by a unique
          amount. Only this deployment's preset sizes are offered, so your notes join
          the existing set. The trade-off is more transactions and fees.{" "}
          <a
            href={getDocUrl("privacy-pool")}
            target="_blank"
            rel="noopener noreferrer"
            className="text-white underline hover:text-glow"
          >
            Learn more
          </a>
        </p>
      </div>

      {/* Plan summary */}
      {quote && (
        <div className="space-y-1.5 mb-5 p-3 rounded-xl bg-ink-950/30 border border-ink-700 font-mono text-xs text-mist/90">
          <p className="text-slate-200 font-medium">This will create</p>
          {plan && canDeposit ? (
            <>
              <div className="flex justify-between gap-3">
                <span>Notes</span>
                <span className="text-white">
                  {plan.chunkCount} × {formatXlm(plan.chunkStroops)} XLM
                </span>
              </div>
              <div className="flex justify-between gap-3">
                <span>Into pool</span>
                <span className="text-success">
                  {formatXlm(plan.totalDepositStroops)} XLM
                </span>
              </div>
              <div className="flex justify-between gap-3">
                <span>Stays as dust</span>
                <span>{formatXlm(plan.remainderStroops)} XLM</span>
              </div>
              {plan.remainderStroops > 0n && (
                <p className="pt-1 text-warning">
                  {formatXlm(plan.remainderStroops)} XLM does not fill a preset note. It
                  stays in this stealth account, and sweeping it later would create an
                  off-preset deposit that stands out in the pool.
                </p>
              )}
            </>
          ) : chunkChoice == null ? (
            <p className="text-mist/70">Choose a note size to see the plan.</p>
          ) : (
            <p className="text-warning">
              Balance is too small for {formatXlm(chunkChoice)} XLM notes. Choose a smaller
              preset.
            </p>
          )}
        </div>
      )}

      {error && (
        <div className="mb-4 p-3 rounded-xl bg-error/10 border border-error/30 text-error text-sm">
          {error}
        </div>
      )}

      {busy && progress && (
        <div className="mb-4 p-3 rounded-xl bg-ink-950/40 border border-ink-700 text-xs text-mist font-mono">
          Depositing note {Math.max(progress.index, 1)} of {progress.count}…
        </div>
      )}

      <div className="flex gap-2 justify-end">
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          className="px-4 py-2 rounded-xl text-sm font-medium text-mist border border-ink-600 bg-ink-950/30 hover:border-white/30 hover:text-white transition-colors disabled:opacity-40"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleConfirm}
          disabled={busy || !canDeposit}
          className={`px-4 py-2 rounded-xl text-sm font-semibold bg-white border border-white text-black hover:bg-black hover:text-white disabled:opacity-40 disabled:cursor-not-allowed ${
            busy ? "loading" : ""
          }`}
        >
          {busy ? "Depositing…" : "Deposit to pool"}
        </button>
      </div>
    </ModalShell>
  );
}
