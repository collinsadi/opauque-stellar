import { performance } from "node:perf_hooks";

interface Announcement {
  announcedAt: number;
  processedAt?: number;
}

const count = Number(process.env.LOAD_TEST_ANNOUNCEMENTS ?? 10_000);
const burstSize = Number(process.env.LOAD_TEST_BURST_SIZE ?? 1_000);
const processingDelayMs = Number(process.env.LOAD_TEST_PROCESSING_DELAY_MS ?? 0);

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index] ?? 0;
}

async function processBurst(burst: Announcement[]): Promise<void> {
  for (const announcement of burst) {
    if (processingDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, processingDelayMs));
    }
    announcement.processedAt = performance.now();
  }
}

async function main(): Promise<void> {
  if (!Number.isInteger(count) || count <= 0 || !Number.isInteger(burstSize) || burstSize <= 0) {
    throw new Error("LOAD_TEST_ANNOUNCEMENTS and LOAD_TEST_BURST_SIZE must be positive integers");
  }

  const startedAt = performance.now();
  const announcements: Announcement[] = Array.from({ length: count }, () => ({
    announcedAt: performance.now(),
  }));
  for (let offset = 0; offset < announcements.length; offset += burstSize) {
    await processBurst(announcements.slice(offset, offset + burstSize));
  }

  const lags = announcements.map((item) => (item.processedAt ?? performance.now()) - item.announcedAt);
  const elapsed = performance.now() - startedAt;
  console.log(JSON.stringify({
    announcements: count,
    burstSize,
    processingDelayMs,
    elapsedMs: Number(elapsed.toFixed(2)),
    throughputPerSecond: Number(((count / elapsed) * 1000).toFixed(2)),
    lagP50Ms: Number(percentile(lags, 50).toFixed(2)),
    lagP95Ms: Number(percentile(lags, 95).toFixed(2)),
    lagP99Ms: Number(percentile(lags, 99).toFixed(2)),
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
