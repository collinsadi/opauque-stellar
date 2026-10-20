/**
 * Sweep funds from a one-time stealth account directly into the privacy pool.
 *
 * Instead of paying a swept stealth balance out to an address (which the sender,
 * who knows the stealth account is yours, can watch), this deposits it into the
 * pool. The stealth account is the transaction source, fee payer, AND `depositor`
 * (Option A), so the connected wallet is never linked to the stealth account.
 * The resulting pool note(s) withdraw unlinkably later via the relayer market or
 * the connected wallet, exactly like any other pool deposit.
 *
 * Depositing in equal chunks grows the withdrawal anonymity set: each note blends
 * with other same-size deposits instead of being fingerprinted by a unique amount.
 */
import { deriveStealthStellarKeypairFromStealthPrivKey, hexToBytes } from "./stealth";
import { getNativeWithdrawalQuote } from "./stellar";
import { fetchNextLeafIndex } from "./poolProver";
import { deriveDeposit, newNoteSecrets, toHex32, type PoolNote } from "./poolNotes";
import { invokePoolDepositWithKeypair } from "./programs";
import { getPoolConfig } from "../contracts/poolConfig";
import { usePoolNoteStore } from "../store/poolNoteStore";

/**
 * Stroops held back per deposit to cover the Soroban resource fee. A pool deposit
 * costs more than a plain payment's base fee, so we reserve a generous buffer; any
 * unused remainder simply stays in the stealth account as dust.
 */
export const DEPOSIT_FEE_BUFFER_STROOPS = 2_000_000n; // 0.2 XLM

/** Smallest deposit we will make per note (below this, pooling is not worthwhile). */
export const MIN_DEPOSIT_STROOPS = 1_000_000n; // 0.1 XLM

const STROOPS_PER_XLM = 10_000_000n;

/**
 * Convert the deployment's whole-XLM deposit presets into per-note chunk sizes in
 * stroops. Invalid or duplicate entries are dropped; the result is ascending.
 * Sweeps must only use these sizes so their notes join the existing anonymity set.
 */
export function presetChunkStroops(presetsXlm: readonly number[]): bigint[] {
  const whole = [...new Set(presetsXlm)].filter((v) => Number.isInteger(v) && v > 0);
  return whole.sort((a, b) => a - b).map((xlm) => BigInt(xlm) * STROOPS_PER_XLM);
}

export type PoolSweepPlan = {
  /** Spendable balance in the stealth account (net of reserve + base fee). */
  spendableStroops: bigint;
  /** Account reserve retained in the stealth account. */
  minimumBalanceStroops: bigint;
  /** Size of each deposit note, in stroops. */
  chunkStroops: bigint;
  /** Number of deposit notes that will be created. */
  chunkCount: number;
  /** Total value moved into the pool, in stroops. */
  totalDepositStroops: bigint;
  /** Approximate residual left in the stealth account (dust + fees), in stroops. */
  remainderStroops: bigint;
};

/** big-endian 32-byte encoding of a field element. */
function be32(v: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let n = v;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

/**
 * Compute how a stealth balance maps onto pool deposits.
 *
 * @param chunkStroops when null, the whole spendable balance becomes one note;
 *   otherwise as many equal notes of this size as fit (each reserving a fee buffer).
 */
export function planPoolSweep(opts: {
  spendableStroops: bigint;
  minimumBalanceStroops: bigint;
  chunkStroops: bigint | null;
}): PoolSweepPlan {
  const { spendableStroops, minimumBalanceStroops } = opts;
  const base = {
    spendableStroops,
    minimumBalanceStroops,
    chunkStroops: 0n,
    chunkCount: 0,
    totalDepositStroops: 0n,
    remainderStroops: spendableStroops,
  };

  if (opts.chunkStroops == null) {
    const value = spendableStroops - DEPOSIT_FEE_BUFFER_STROOPS;
    if (value < MIN_DEPOSIT_STROOPS) return base;
    return {
      ...base,
      chunkStroops: value,
      chunkCount: 1,
      totalDepositStroops: value,
      remainderStroops: spendableStroops - value,
    };
  }

  const chunk = opts.chunkStroops;
  if (chunk < MIN_DEPOSIT_STROOPS) return base;
  const perChunkCost = chunk + DEPOSIT_FEE_BUFFER_STROOPS;
  const chunkCount = Number(spendableStroops / perChunkCost);
  if (chunkCount < 1) return base;
  const totalDepositStroops = BigInt(chunkCount) * chunk;
  return {
    ...base,
    chunkStroops: chunk,
    chunkCount,
    totalDepositStroops,
    remainderStroops: spendableStroops - BigInt(chunkCount) * perChunkCost,
  };
}

/** Fetch the spendable balance of a stealth account for planning a pool sweep. */
export async function quoteStealthSpendable(stealthStellarAddress: string): Promise<{
  spendableStroops: bigint;
  minimumBalanceStroops: bigint;
}> {
  // Destination is irrelevant for the spendable figure (reserve + fee are the same);
  // reuse the withdrawal quote against the source itself.
  const quote = await getNativeWithdrawalQuote({
    sourcePublicKey: stealthStellarAddress,
    destination: stealthStellarAddress,
  });
  return {
    spendableStroops: quote.spendableStroops,
    minimumBalanceStroops: quote.minimumBalanceStroops,
  };
}

export type PoolSweepProgress = (e: {
  phase: "depositing" | "done";
  chunkIndex: number;
  chunkCount: number;
  hash?: string;
}) => void;

export type PoolSweepResult = {
  hashes: string[];
  notesAdded: number;
  totalDepositStroops: bigint;
};

async function depositChunk(opts: {
  keypair: ReturnType<typeof deriveStealthStellarKeypairFromStealthPrivKey>;
  value: bigint;
  scope: number;
  poolId: string;
  cluster: string;
}): Promise<{ hash: string; note: PoolNote }> {
  const from = opts.keypair.publicKey();
  // Re-read the next leaf index per chunk; retry once if a concurrent deposit
  // (or the previous chunk in this loop) shifted it under us.
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const leafIndex = await fetchNextLeafIndex(from);
    const { nullifier, secret } = newNoteSecrets();
    const derived = await deriveDeposit({
      value: opts.value,
      scope: opts.scope,
      leafIndex,
      nullifier: BigInt(nullifier),
      secret: BigInt(secret),
    });
    try {
      const hash = await invokePoolDepositWithKeypair({
        keypair: opts.keypair,
        value: opts.value,
        commitment: be32(derived.commitment),
        expectedIndex: leafIndex,
      });
      const note: PoolNote = {
        cluster: opts.cluster,
        poolId: opts.poolId,
        value: opts.value.toString(),
        scope: opts.scope,
        leafIndex,
        nullifier,
        secret,
        commitment: toHex32(derived.commitment),
        spent: false,
        createdAt: Date.now(),
      };
      return { hash, note };
    } catch (err) {
      lastErr = err;
      // Only the index race is worth retrying; surface anything else immediately.
      const msg = err instanceof Error ? err.message : String(err);
      if (!/IndexMismatch|ContractError/i.test(msg) || attempt === 2) throw err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("Pool deposit failed.");
}

/**
 * Move a stealth account's spendable balance into the privacy pool as one or more
 * notes. Each note is persisted to the pool note store immediately on success, so
 * an interrupted sweep never loses a note. Returns the submitted transaction hashes.
 */
export async function sweepStealthIntoPool(opts: {
  stealthPrivKeyHex: string;
  cluster: string;
  plan: PoolSweepPlan;
  onProgress?: PoolSweepProgress;
}): Promise<PoolSweepResult> {
  const cfg = getPoolConfig();
  if (!cfg) throw new Error("Privacy pool is not deployed on this network.");
  if (opts.plan.chunkCount < 1 || opts.plan.chunkStroops < MIN_DEPOSIT_STROOPS) {
    throw new Error("Balance is too small to deposit into the pool.");
  }

  const stealthPrivBytes = hexToBytes(
    opts.stealthPrivKeyHex.startsWith("0x")
      ? (opts.stealthPrivKeyHex as `0x${string}`)
      : (`0x${opts.stealthPrivKeyHex}` as `0x${string}`),
  );
  const keypair = deriveStealthStellarKeypairFromStealthPrivKey(stealthPrivBytes);

  const hashes: string[] = [];
  const addNote = usePoolNoteStore.getState().addNote;
  const { chunkCount, chunkStroops } = opts.plan;

  for (let i = 0; i < chunkCount; i += 1) {
    opts.onProgress?.({ phase: "depositing", chunkIndex: i + 1, chunkCount });
    const { hash, note } = await depositChunk({
      keypair,
      value: chunkStroops,
      scope: cfg.scope,
      poolId: cfg.poolId,
      cluster: opts.cluster,
    });
    addNote(note);
    hashes.push(hash);
    opts.onProgress?.({ phase: "depositing", chunkIndex: i + 1, chunkCount, hash });
  }

  opts.onProgress?.({ phase: "done", chunkIndex: chunkCount, chunkCount });
  return {
    hashes,
    notesAdded: chunkCount,
    totalDepositStroops: chunkStroops * BigInt(chunkCount),
  };
}
