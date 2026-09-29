# Indexer Ingestion Load Test

The synthetic harness at `asp/scripts/indexer-load-test.ts` models burst announcement arrival and serial indexer processing. It reports throughput and ingestion lag percentiles without contacting Stellar or publishing transactions.

Run it from the repository root:

```sh
npx tsx asp/scripts/indexer-load-test.ts
```

Parameters are configurable with `LOAD_TEST_ANNOUNCEMENTS`, `LOAD_TEST_BURST_SIZE`, and `LOAD_TEST_PROCESSING_DELAY_MS`. The output is JSON so it can be stored as a CI artifact or imported into an issue.

## Hardware Baseline

Baseline environment: Apple MacBook Pro, Apple Silicon, 16 GB RAM, macOS, Node.js 22. The command used 10,000 announcements, 1,000 announcements per burst, and zero artificial processing delay on 2026-08-25.

Measured result from the latest run: 793,099.84 announcements/second, 5.10 ms P50 lag, 6.65 ms P95 lag, and 6.77 ms P99 lag. This is an in-memory ingestion ceiling, not a production capacity claim; RPC fetch, durable writes, and root computation are outside this harness. Those boundaries are the next bottlenecks to measure and should be filed as separate follow-up issues with hardware, Node.js version, and command parameters attached.
