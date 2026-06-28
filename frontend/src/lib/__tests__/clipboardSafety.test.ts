import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CLIPBOARD_CLEAR_TIMEOUT_MS,
  MAX_CLIPBOARD_CLEAR_TIMEOUT_MS,
  MIN_CLIPBOARD_CLEAR_TIMEOUT_MS,
  copySensitiveValue,
  formatClipboardClearTimeout,
  normalizeClipboardClearTimeoutMs,
  scheduleClipboardClear,
} from "../clipboardSafety";

describe("clipboardSafety", () => {
  it("normalizes clipboard clear timeout bounds", () => {
    expect(normalizeClipboardClearTimeoutMs(Number.NaN)).toBe(DEFAULT_CLIPBOARD_CLEAR_TIMEOUT_MS);
    expect(normalizeClipboardClearTimeoutMs(100)).toBe(MIN_CLIPBOARD_CLEAR_TIMEOUT_MS);
    expect(normalizeClipboardClearTimeoutMs(999_999)).toBe(MAX_CLIPBOARD_CLEAR_TIMEOUT_MS);
  });

  it("formats the timeout for settings copy", () => {
    expect(formatClipboardClearTimeout(30_000)).toBe("30 seconds");
  });

  it("copies sensitive values and schedules a clipboard clear", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const setTimer = vi.fn();

    await copySensitiveValue("secret-meta-address", {
      clipboard: { writeText },
      clearAfterMs: 10_000,
      setTimer: setTimer as unknown as typeof setTimeout,
    });

    expect(writeText).toHaveBeenCalledWith("secret-meta-address");
    expect(setTimer).toHaveBeenCalledWith(expect.any(Function), 10_000);
  });

  it("does not clear if clipboard contents changed before the timeout", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const readText = vi.fn().mockResolvedValue("new-value");
    let task: (() => void) | undefined;

    scheduleClipboardClear("old-value", {
      clipboard: { writeText, readText },
      setTimer: ((callback: () => void) => {
        task = callback;
        return 1;
      }) as unknown as typeof setTimeout,
    });

    task?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(writeText).not.toHaveBeenCalled();
  });
});