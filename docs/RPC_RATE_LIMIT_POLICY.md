# RPC Rate Limit Policy

## Overview

The scanner implements exponential backoff for Horizon/RPC rate limit responses to ensure graceful degradation and eventual sync completion under rate-limited conditions.

## Rate Limit Detection

The scanner detects rate limits through multiple signals:

1. HTTP 429 status code on response
2. Status field in error object
3. Error message containing "429"
4. Error message containing "rate limit" (case-insensitive)

## Backoff Strategy

### Exponential Backoff

The retry delay follows an exponential backoff pattern with capping:

```
delay = min(BASE_DELAY * 2^attempt, MAX_DELAY)
```

Where:
- `BASE_DELAY = 1000ms` (1 second)
- `MAX_DELAY = 32000ms` (32 seconds)
- `attempt` = 0-indexed retry count

### Retry Schedule

| Attempt | Delay |
|---------|-------|
| 1 | 1s |
| 2 | 2s |
| 3 | 4s |
| 4 | 8s |
| 5 | 16s |
| 6+ | 32s (capped) |

## Configuration

### Max Retries

- **Value**: 5 retries
- **Total attempts**: 6 (initial + 5 retries)
- **Maximum wait time**: ~63 seconds cumulative

After exhausting all retries, the error propagates to the user with appropriate messaging.

## User Experience

### Progress Updates

During rate-limited retries, users see:

```
Rate limited. Retrying in 4s (attempt 3/5)…
```

The progress bar and sync phase remain visible to indicate the scanner has not failed.

### Successful Recovery

When a retry succeeds:
- Progress message returns to normal sync status
- `retryStatus` field is cleared from progress object
- Sync continues from the last successful checkpoint

### Exhausted Retries

When all retries fail:
- Progress phase transitions to "error"
- Error message indicates rate limit exhaustion
- User can manually retry sync or wait before trying again

## Implementation Details

### Non-Blocking

Rate limit backoff uses `setTimeout` to avoid blocking the main thread or other concurrent operations.

### Per-Request Retry

Each RPC request has its own retry counter. A single rate-limited request does not affect the retry budget of subsequent requests.

### Checkpoint Preservation

Partial sync progress is saved before each retry, so if the user closes the app during backoff, the next session resumes from the last successful ledger.

## Best Practices

### For Users

1. **Wait for automatic retry**: The scanner will retry automatically with increasing delays
2. **Avoid manual refresh spam**: Each refresh resets the sync and may trigger more rate limits
3. **Use incremental sync**: Let the scanner complete once, then subsequent syncs are faster

### For Developers

1. **Monitor retry telemetry**: Track how often rate limits occur in production
2. **Adjust MAX_RETRIES**: Increase for production if rate limits are frequent
3. **Consider request throttling**: Add delay between successful requests to stay under rate limits
4. **Cache aggressively**: IndexedDB checkpoint persistence reduces RPC load

## Testing

### Simulating Rate Limits

To test backoff behavior:

1. Use a local Horizon instance with aggressive rate limits
2. Mock the `publicClient.getEvents()` response with 429 status
3. Verify exponential delay between retries
4. Confirm progress message updates correctly
5. Test exhaustion of max retries

### Expected Behavior

```typescript
// Attempt 1: immediate
// Attempt 2: wait 1s
// Attempt 3: wait 2s
// Attempt 4: wait 4s
// Attempt 5: wait 8s
// Attempt 6: wait 16s
// Then fail if still rate limited
```

## Future Enhancements

1. **Adaptive batch sizing**: Reduce BATCH_SIZE when rate limits occur
2. **Jitter**: Add random jitter to backoff delays to avoid thundering herd
3. **Request throttling**: Proactive rate limiting to avoid 429 responses
4. **Rate limit headers**: Parse `Retry-After` header if provided by Horizon

## Conclusion

The exponential backoff strategy ensures:
- ✅ Graceful handling of transient rate limits
- ✅ Eventual sync completion under normal conditions
- ✅ User-visible retry status
- ✅ Documented max retry policy
- ✅ No infinite retry loops

This implementation satisfies the acceptance criteria for issue #397.
