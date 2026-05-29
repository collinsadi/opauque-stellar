/**
 * Focus-trap hook for modals (#109).
 *
 * On open: focuses the first focusable inside the container and
 * captures Tab/Shift+Tab so focus stays inside the modal. On close:
 * restores focus to the element that was focused before the modal
 * opened (so keyboard users land back on the trigger button rather
 * than at the top of the document).
 *
 * Pure DOM — no portal / framework assumptions. Compatible with
 * native dialog markup and the project's `ModalShell` div-based
 * dialog.
 */

import { useEffect, useRef } from "react";

const FOCUSABLE_SELECTORS = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function useFocusTrap(active: boolean) {
  const containerRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    previouslyFocused.current = (document.activeElement as HTMLElement | null) ?? null;

    // Defer the focus to the next frame so the modal's DOM has
    // settled (transitions, lazy children, etc.).
    const id = window.requestAnimationFrame(() => {
      const first = container.querySelector<HTMLElement>(FOCUSABLE_SELECTORS);
      if (first) first.focus();
      else container.focus();
    });

    const handleKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const focusable = Array.from(
        container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTORS),
      ).filter((el) => !el.hasAttribute("data-focus-trap-ignore"));
      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const current = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (current === first || !container.contains(current)) {
          last.focus();
          e.preventDefault();
        }
      } else {
        if (current === last || !container.contains(current)) {
          first.focus();
          e.preventDefault();
        }
      }
    };

    document.addEventListener("keydown", handleKey, true);
    return () => {
      window.cancelAnimationFrame(id);
      document.removeEventListener("keydown", handleKey, true);
      previouslyFocused.current?.focus?.();
    };
  }, [active]);

  return containerRef;
}
