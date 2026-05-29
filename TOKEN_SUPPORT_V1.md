# Asset support — v1 scope (#111)

opaque-mainnet-v1 supports **native XLM only**. This document is the
canonical statement of v1 asset scope so reviewers don't have to grep
for stray copy.

## What v1 supports

- Private sends, receives, and withdrawals denominated in **XLM
  stroops** (`1 XLM = 10_000_000 stroops`).
- Transaction history rendering with `lib/i18n-format.ts`
  (#110) — both display and parse paths treat the amount as XLM.

## What v1 does NOT support

- Stellar issued assets (USDC, USDT, EURC, AQUA, etc.).
- Soroban contract tokens.
- Multi-asset balances on a single ghost / watchlist address.

## Why

Native-XLM-only keeps the proof circuits, the rate-limit budgets, and
the on-chain trait surface small enough to land v1. Adding Stellar
assets requires:

- Per-asset trustline gating in the issuance + claim flows.
- Multi-asset balance scanning + UI affordances.
- Per-asset proof-time accounting in the circuits (currently the
  amount field is sized for XLM stroops only).

A multi-asset follow-up will land under a separate epic; the
`ghostTokenBalances: Record<string, Record<string, bigint>>` field
returned by `useScanner` is the placeholder shape that follow-up will
fill in. In v1 it is always `{}`.

## Surfaces audited

The following components were audited for accidental token-balance
affordances during this change. None showed user-visible token /
USDC / USDT UI as of this PR; the only change required was the
removal of the misleading *"reserved for future use"* comment in
`src/hooks/useScanner.ts` (#111).

- `src/components/SendView.tsx`
- `src/components/PayPage.tsx`
- `src/components/PrivateBalanceView.tsx`
- `src/components/TransactionHistoryView.tsx`
- `src/components/DashboardView.tsx`

If a future change introduces an unsupported token affordance, it
should either implement the asset support outright OR gate the UI
behind a feature flag with this document updated to reflect the new
scope.
