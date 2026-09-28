# SendView.tsx Patches

## Issue #923: Bounded Polling with Timeout and Abort

Replace the announcement polling loop (lines ~290-295) with:

```typescript
import { pollWithTimeout } from "../lib/pollingUtils";

// Inside handleSend(), replace:
// let announceResp = await soroban.getTransaction(announceSend.hash);
// while (announceResp.status === "NOT_FOUND") {
//   await new Promise((r) => setTimeout(r, 1000));
//   announceResp = await soroban.getTransaction(announceSend.hash);
// }

// With:
const abortController = new AbortController();
const pollResult = await pollWithTimeout({
  fetchFn: () => soroban.getTransaction(announceSend.hash),
  condition: (resp) => resp.status !== "NOT_FOUND",
  timeoutMs: 30_000, // 30 second timeout
  intervalMs: 1_000,
  backoffMultiplier: 1.2,
  signal: abortController.signal,
});

if (!pollResult.success) {
  resolvePendingTx(announceSend.hash, "failed", "TIMEOUT");
  if (pollResult.timedOut) {
    throw new Error("Announcement confirmation timed out after 30s. Check explorer later.");
  } else if (pollResult.aborted) {
    throw new Error("Announcement polling cancelled.");
  } else {
    throw new Error(`Polling error: ${pollResult.error?.message}`);
  }
}

const announceResp = pollResult.result!;
```

Add cleanup on unmount:

```typescript
// At top of handleSend():
const abortController = new AbortController();

// Return cleanup in useEffect (add new effect):
useEffect(() => {
  return () => {
    // Abort polling if component unmounts
    if (abortController) abortController.abort();
  };
}, []);
```

## Issue #922: Validate Before Busy State

Replace the validation logic (lines ~180-210) with:

```typescript
const handleSend = async () => {
  setError(null);
  setTxHash(null);
  
  // VALIDATE FIRST - before setting busy state
  if (!currentConfig || !publicKey || !signTransaction || !connected) {
    setError("Connect Freighter on a supported network.");
    return; // No setSending(true) yet
  }
  
  let recipientMeta = recipient.trim();
  if (!recipientMeta || !amount) {
    setError("Enter recipient and amount.");
    return; // No setSending(true) yet
  }

  // Try to extract meta-address from payment link
  const linkMeta = extractMetaFromPaymentLink(recipientMeta, network);
  if (linkMeta) {
    recipientMeta = linkMeta.metaAddress;
    if (linkMeta.amount && !amount) {
      setAmount(linkMeta.amount);
    }
  }

  // Parse and validate amount BEFORE entering busy state
  let value: bigint;
  try {
    value = parseXlmToStroops(amount);
  } catch {
    setError("Invalid amount format.");
    return; // No setSending(true)
  }

  // Explicit checks for bad amounts
  if (value < 0n) {
    setError("Amount cannot be negative.");
    return;
  }
  if (value === 0n) {
    setError("Amount must be greater than 0.");
    return;
  }
  if (maxSendableBalance != null && value > maxSendableBalance) {
    setError(`Insufficient balance. Maximum: ${formatXlm(maxSendableBalance)} XLM`);
    return;
  }

  // NOW set busy state - all validation passed
  setSending(true);
  setSteps([]);
  
  // ... rest of the send flow
  
  // IMPORTANT: Wrap entire try block in try/finally to ensure setSending(false)
  try {
    // ... existing send logic
  } catch (e) {
    // ... existing error handling
  } finally {
    setSending(false); // Always reset, even on error
  }
};
```

## Testing

Add test file `SendView.test.tsx`:

```typescript
import { describe, it, expect, vi } from 'vitest';

describe('SendView validation', () => {
  it('rejects zero amount before busy state', () => {
    // Test that zero amount errors without setting sending=true
  });

  it('rejects negative amount', () => {
    // Test negative amount validation
  });

  it('resets sending state on error', () => {
    // Test finally block always runs
  });
});
```
