export const DEFAULT_CLIPBOARD_CLEAR_TIMEOUT_MS = 30_000;
export const MIN_CLIPBOARD_CLEAR_TIMEOUT_MS = 5_000;
export const MAX_CLIPBOARD_CLEAR_TIMEOUT_MS = 300_000;

type ClipboardLike = {
  writeText: (text: string) => Promise<void>;
  readText?: () => Promise<string>;
};

type TimerLike = ReturnType<typeof setTimeout>;

export function normalizeClipboardClearTimeoutMs(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_CLIPBOARD_CLEAR_TIMEOUT_MS;
  return Math.min(
    MAX_CLIPBOARD_CLEAR_TIMEOUT_MS,
    Math.max(MIN_CLIPBOARD_CLEAR_TIMEOUT_MS, Math.round(value)),
  );
}

export function formatClipboardClearTimeout(ms: number): string {
  const seconds = Math.round(normalizeClipboardClearTimeoutMs(ms) / 1000);
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

export function scheduleClipboardClear(
  copiedValue: string,
  options: {
    clipboard?: ClipboardLike;
    clearAfterMs?: number;
    setTimer?: typeof setTimeout;
  } = {},
): TimerLike | null {
  const clipboard = options.clipboard ?? globalThis.navigator?.clipboard;
  if (!clipboard?.writeText) return null;

  const delay = normalizeClipboardClearTimeoutMs(
    options.clearAfterMs ?? DEFAULT_CLIPBOARD_CLEAR_TIMEOUT_MS,
  );
  const setTimer = options.setTimer ?? setTimeout;

  return setTimer(() => {
    void (async () => {
      try {
        if (clipboard.readText) {
          const current = await clipboard.readText();
          if (current !== copiedValue) return;
        }
        await clipboard.writeText("");
      } catch {
        try {
          await clipboard.writeText("");
        } catch {
          // Ignore clipboard clearing failures; browsers can reject background writes.
        }
      }
    })();
  }, delay);
}

export async function copySensitiveValue(
  value: string,
  options: {
    clipboard?: ClipboardLike;
    clearAfterMs?: number;
    setTimer?: typeof setTimeout;
  } = {},
): Promise<TimerLike | null> {
  const clipboard = options.clipboard ?? globalThis.navigator?.clipboard;
  if (!clipboard?.writeText) {
    throw new Error("Clipboard API is unavailable.");
  }

  await clipboard.writeText(value);
  return scheduleClipboardClear(value, options);
}