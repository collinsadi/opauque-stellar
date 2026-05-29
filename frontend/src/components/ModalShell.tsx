import { useEffect, useId, type ReactNode } from "react";
import { useFocusTrap } from "../lib/a11y/useFocusTrap";

type ModalShellProps = {
  open: boolean;
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  onClose: () => void;
  /** When false, clicking the backdrop won't close. */
  closeOnBackdrop?: boolean;
  maxWidthClassName?: string;
  contentClassName?: string;
};

export function ModalShell({
  open,
  title,
  description,
  children,
  onClose,
  closeOnBackdrop = true,
  maxWidthClassName = "max-w-md",
  contentClassName = "",
}: ModalShellProps) {
  // #109: focus trap + restore. Hook is no-op when `open` is false.
  const containerRef = useFocusTrap(open);
  const titleId = useId();
  const descId = useId();

  // #109: Esc closes the modal — standard dialog behaviour.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-60 flex items-center justify-center p-4 bg-ink-950/70 backdrop-blur-md"
      role="dialog"
      aria-modal="true"
      aria-labelledby={title != null ? titleId : undefined}
      aria-describedby={description != null ? descId : undefined}
      onClick={() => closeOnBackdrop && onClose()}
    >
      <div
        ref={containerRef}
        tabIndex={-1}
        className={`w-full ${maxWidthClassName} overflow-hidden rounded-2xl border border-ink-700 bg-ink-900/95 shadow-2xl backdrop-blur-lg ${contentClassName}`}
        onClick={(e) => e.stopPropagation()}
      >
        {(title != null || description != null) && (
          <div className="border-b border-ink-700/60 px-6 pb-4 pt-6">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                {title != null ? (
                  <h3
                    id={titleId}
                    className="font-display text-base font-bold text-white"
                  >
                    {title}
                  </h3>
                ) : null}
                {description != null ? (
                  <div id={descId} className="mt-1 text-sm text-mist">
                    {description}
                  </div>
                ) : null}
              </div>
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg p-1 text-mist/70 transition-colors hover:text-white"
                aria-label="Close"
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          </div>
        )}

        <div className="px-6 py-5">{children}</div>
      </div>
    </div>
  );
}

