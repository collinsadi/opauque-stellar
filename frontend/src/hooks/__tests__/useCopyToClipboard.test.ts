/**
 * @vitest-environment jsdom
 *
 * Tests for the useCopyToClipboard hook (#557 / #1102).
 *
 * Covers the secure-copy path used by ghost ephemeral keys: auto-clear fires
 * after the countdown, copy failures surface as "unsupported" rather than
 * being silently swallowed, and the caller can cancel the clear.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useCopyToClipboard } from "../useCopyToClipboard";

// ---------------------------------------------------------------------------
// Clipboard mock helpers
// ---------------------------------------------------------------------------

function setupClipboardMock(opts: { failWrite?: boolean } = {}) {
  const written: string[] = [];
  const writeText = vi.fn(async (text: string) => {
    if (opts.failWrite) throw new DOMException("NotAllowedError", "NotAllowedError");
    written.push(text);
  });
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    writable: true,
    configurable: true,
  });
  return { written, writeText };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Secret copy path (#1102 — ephemeral key auto-clear)
// ---------------------------------------------------------------------------

describe("useCopyToClipboard — secret: true (ephemeral key path)", () => {
  it("writes the value and transitions to 'copied'", async () => {
    const { written } = setupClipboardMock();
    const { result } = renderHook(() =>
      useCopyToClipboard({ secret: true, clearAfterSeconds: 5 }),
    );

    await act(async () => {
      await result.current.copy("0xdeadbeef_ephemeral_key");
    });

    expect(result.current.status).toBe("copied");
    expect(written).toContain("0xdeadbeef_ephemeral_key");
  });

  it("sets a non-zero remaining countdown after a secret copy", async () => {
    setupClipboardMock();
    const { result } = renderHook(() =>
      useCopyToClipboard({ secret: true, clearAfterSeconds: 10 }),
    );

    await act(async () => {
      await result.current.copy("secret_key_value");
    });

    expect(result.current.remaining).toBe(10);
  });

  it("auto-clears the clipboard after the countdown expires", async () => {
    const { written } = setupClipboardMock();
    const { result } = renderHook(() =>
      useCopyToClipboard({ secret: true, clearAfterSeconds: 5 }),
    );

    await act(async () => {
      await result.current.copy("secret_key_value");
    });

    // Advance past the clear delay
    await act(async () => {
      vi.advanceTimersByTime(5001);
    });

    // After clear the clipboard should have been overwritten with an empty
    // string and status reset to idle
    expect(written[written.length - 1]).toBe("");
    expect(result.current.status).toBe("idle");
    expect(result.current.remaining).toBe(0);
  });

  it("surfaces copy failures as 'unsupported' — not silently ignored", async () => {
    setupClipboardMock({ failWrite: true });
    const { result } = renderHook(() =>
      useCopyToClipboard({ secret: true }),
    );

    await act(async () => {
      await result.current.copy("secret_key_value");
    });

    // The old ReceiveView code used `catch { // ignore }` — this asserts the
    // correct behaviour: status becomes "unsupported" so callers can show an
    // error message instead of silently failing.
    expect(result.current.status).toBe("unsupported");
  });

  it("cancelClear stops the countdown without clearing the clipboard", async () => {
    const { written } = setupClipboardMock();
    const { result } = renderHook(() =>
      useCopyToClipboard({ secret: true, clearAfterSeconds: 5 }),
    );

    await act(async () => {
      await result.current.copy("secret_key_value");
    });

    // Cancel before the timer fires
    act(() => {
      result.current.cancelClear();
    });

    expect(result.current.remaining).toBe(0);

    // Advance well past the original deadline — clipboard should NOT have
    // been cleared (no second write call)
    await act(async () => {
      vi.advanceTimersByTime(10000);
    });

    expect(written).not.toContain("");
  });
});

// ---------------------------------------------------------------------------
// Non-secret copy path (addresses, links — unchanged behaviour)
// ---------------------------------------------------------------------------

describe("useCopyToClipboard — secret: false (non-secret path)", () => {
  it("writes value and transitions to 'copied'", async () => {
    const { written } = setupClipboardMock();
    const { result } = renderHook(() => useCopyToClipboard());

    await act(async () => {
      await result.current.copy("some_public_address");
    });

    expect(result.current.status).toBe("copied");
    expect(written).toContain("some_public_address");
  });

  it("resets to idle after the flash timeout without writing an empty string", async () => {
    const { written } = setupClipboardMock();
    const { result } = renderHook(() => useCopyToClipboard());

    await act(async () => {
      await result.current.copy("some_public_address");
    });

    await act(async () => {
      vi.advanceTimersByTime(2001);
    });

    expect(result.current.status).toBe("idle");
    // No auto-clear write for non-secret copies
    expect(written).not.toContain("");
  });
});
