# Opaque Stellar Fixes - Issues #920-923

## Issue #923: Bound the announcement status polling loop ✅
**Problem**: Polling loop has no timeout or unmount cancellation
**Fix**: Added timeout (30s), backoff, AbortController for unmount cleanup
**Location**: frontend/src/components/SendView.tsx

## Issue #922: Harden send flow validation and busy-state handling ✅
**Problem**: Invalid amount leaves button stuck on "Sending..."
**Fix**: Validate before entering busy state, explicit negative/zero checks
**Location**: frontend/src/components/SendView.tsx

## Issue #923: Add indexer fallback for pool tree reconstruction ✅
**Problem**: Old deposits beyond RPC retention become unprovable
**Fix**: Added indexer fallback and page-cap detection
**Location**: frontend/src/lib/poolProver.ts

## Issue #920: Fix false on-device privacy claim ✅
**Problem**: UI claims "no data leaves browser" but POSTs to publisher
**Fix**: Accurate privacy disclosure, minimal payload
**Location**: frontend/src/components/ProofGeneratorModal.tsx, docs/

All fixes: lightweight, backward compatible, production-ready.
