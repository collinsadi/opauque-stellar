import { describe, expect, it } from "vitest";
import {
  DEPOSIT_FEE_BUFFER_STROOPS,
  presetChunkStroops,
  planPoolSweep,
} from "../poolSweep";

const XLM = 10_000_000n;

describe("presetChunkStroops", () => {
  it("maps manifest presets to ascending stroop chunk sizes", () => {
    expect(presetChunkStroops([1000, 10, 10000, 100])).toEqual([
      10n * XLM,
      100n * XLM,
      1000n * XLM,
      10000n * XLM,
    ]);
  });

  it("drops invalid, non-integer, non-positive, and duplicate presets", () => {
    expect(presetChunkStroops([10, 10, 0, -5, 2.5, Number.NaN, 100])).toEqual([
      10n * XLM,
      100n * XLM,
    ]);
  });

  it("returns no chunks when the deployment has no presets", () => {
    expect(presetChunkStroops([])).toEqual([]);
  });

  it("never offers the old 1, 5, or 10 XLM sizes unless the manifest lists them", () => {
    const chunks = presetChunkStroops([10, 100, 1000, 10000]);
    expect(chunks).not.toContain(1n * XLM);
    expect(chunks).not.toContain(5n * XLM);
  });
});

describe("planPoolSweep against deployment presets", () => {
  it("fills whole preset-sized notes and reports the off-preset remainder", () => {
    const [ten] = presetChunkStroops([10]);
    const spendable = 25n * XLM;
    const plan = planPoolSweep({
      spendableStroops: spendable,
      minimumBalanceStroops: 1n * XLM,
      chunkStroops: ten,
    });

    // Each 10 XLM note also reserves the fee buffer, so two notes fit in 25 XLM.
    expect(plan.chunkCount).toBe(2);
    expect(plan.chunkStroops).toBe(10n * XLM);
    expect(plan.totalDepositStroops).toBe(20n * XLM);
    expect(plan.remainderStroops).toBe(spendable - 2n * (10n * XLM + DEPOSIT_FEE_BUFFER_STROOPS));
  });

  it("produces no deposits when the balance is below the smallest preset", () => {
    const [ten] = presetChunkStroops([10]);
    const plan = planPoolSweep({
      spendableStroops: 5n * XLM,
      minimumBalanceStroops: 1n * XLM,
      chunkStroops: ten,
    });

    expect(plan.chunkCount).toBe(0);
    expect(plan.totalDepositStroops).toBe(0n);
    expect(plan.remainderStroops).toBe(5n * XLM);
  });

  it("leaves a remainder with no preset-sized note when a larger preset does not fit", () => {
    const [, hundred] = presetChunkStroops([10, 100]);
    const plan = planPoolSweep({
      spendableStroops: 50n * XLM,
      minimumBalanceStroops: 1n * XLM,
      chunkStroops: hundred,
    });

    expect(plan.chunkCount).toBe(0);
    expect(plan.remainderStroops).toBe(50n * XLM);
  });
});
