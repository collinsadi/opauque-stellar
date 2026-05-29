/**
 * Destination memo helpers (#112).
 *
 * Many Stellar exchanges/custodians share one deposit address across
 * many user accounts, using the transaction memo to disambiguate.
 * Sending to such an address WITHOUT a memo loses funds.
 *
 * This module:
 *   1. Maintains a small allowlist of well-known custodial deposit
 *      addresses (Binance, Coinbase, Kraken, KuCoin, …) — extend as
 *      we learn about new ones.
 *   2. Exposes `memoRiskFor(address)` to drive the inline warning.
 *   3. Exposes `validateMemo(memo)` so the form can reject invalid
 *      values BEFORE the contract layer does.
 *
 * Acceptance criteria (#112):
 *   - User can include memo on withdrawal.
 *   - UI warns about exchange/custodian memo risk.
 *   - Transaction builder includes memo correctly.
 */

export type MemoType = "none" | "text" | "id" | "hash" | "return";

/**
 * Known custodian deposit addresses (canonical, mainnet). The list
 * is intentionally hand-curated; add entries as they're verified
 * directly with each custodian.
 */
const CUSTODIAL_ADDRESSES: Readonly<
  Record<string, { name: string; recommendedMemoType: MemoType }>
> = Object.freeze({
  GA5XIGA5C7QTPTWXQHY6MCJRMTRZDOSHR6EFIBNDQTCQHG262N4GGKTM: {
    name: "Kraken",
    recommendedMemoType: "id",
  },
  GCGNWKCJ3KHRLPM3TMQN7IPVUMRPMYIPGKDPELDPRBMVUPLNZAJDK4VG: {
    name: "Binance",
    recommendedMemoType: "text",
  },
  GBJ65CCWNPGFNXIVRZMNQSGNXHJYM3O3HFK2CIHWXVKAFEWZNUQOH53I: {
    name: "Coinbase",
    recommendedMemoType: "text",
  },
  GDXBP3R6N62YR4MTEGEHDIJWQ6BIRYNG6UCV4XQEFKQGGYS7QUDXMJSX: {
    name: "KuCoin",
    recommendedMemoType: "text",
  },
});

export interface MemoRisk {
  /** True when the destination is on the known-custodial allowlist. */
  isKnownCustodian: boolean;
  /** Friendly name for the warning copy. */
  custodianName?: string;
  /** Recommended memo type to use when the destination is custodial. */
  recommendedMemoType?: MemoType;
}

/**
 * Look up the memo risk for `destination`. Always safe — returns
 * `{ isKnownCustodian: false }` when the address isn't on the list.
 */
export function memoRiskFor(destination: string | undefined | null): MemoRisk {
  if (!destination) return { isKnownCustodian: false };
  const entry = CUSTODIAL_ADDRESSES[destination.trim()];
  if (!entry) return { isKnownCustodian: false };
  return {
    isKnownCustodian: true,
    custodianName: entry.name,
    recommendedMemoType: entry.recommendedMemoType,
  };
}

export interface MemoValidationResult {
  ok: boolean;
  error?: string;
}

/**
 * Validate a memo value against the Stellar memo spec for the given
 * memo type. Empty memo with type "none" is allowed; everything else
 * must satisfy the type's constraints.
 */
export function validateMemo(memoType: MemoType, memo: string | undefined): MemoValidationResult {
  const value = (memo ?? "").trim();
  if (memoType === "none") {
    if (value.length > 0) {
      return { ok: false, error: "Memo must be empty when memo type is 'none'." };
    }
    return { ok: true };
  }
  if (value.length === 0) {
    return { ok: false, error: "Memo is required for this memo type." };
  }
  switch (memoType) {
    case "text": {
      // Stellar text memos: up to 28 bytes UTF-8.
      const bytes = new TextEncoder().encode(value).byteLength;
      if (bytes > 28) {
        return { ok: false, error: "Text memo must be 28 UTF-8 bytes or fewer." };
      }
      return { ok: true };
    }
    case "id": {
      // Unsigned 64-bit integer.
      if (!/^\d+$/.test(value)) {
        return { ok: false, error: "ID memo must be a non-negative integer." };
      }
      try {
        const n = BigInt(value);
        if (n < 0n || n > 0xffffffffffffffffn) {
          return { ok: false, error: "ID memo must fit in an unsigned 64-bit integer." };
        }
      } catch {
        return { ok: false, error: "ID memo must be a non-negative integer." };
      }
      return { ok: true };
    }
    case "hash":
    case "return": {
      // 32-byte hex hash.
      if (!/^[0-9a-fA-F]{64}$/.test(value)) {
        return { ok: false, error: "Hash/return memo must be 64 hexadecimal characters." };
      }
      return { ok: true };
    }
  }
}

/**
 * Convenience helper for the form UI: returns the warning copy the
 * inline banner should render, or `null` when no warning is needed.
 */
export function memoWarningCopy(risk: MemoRisk, memo: string | undefined): string | null {
  if (!risk.isKnownCustodian) return null;
  if (memo && memo.trim().length > 0) return null;
  return `Destination looks like ${risk.custodianName ?? "an exchange or custodian"}. Sending without a memo may result in lost funds.`;
}
