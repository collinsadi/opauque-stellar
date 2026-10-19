"use client";

/**
 * OriginKeyWarningBanner
 *
 * Warns users when the current origin differs from the one used to derive
 * their stealth keys (issue #1138). A domain move, preview deployment, or
 * mirror silently produces different keys and payments sent to the old
 * meta-address stop appearing.
 */

import { useOriginKeyWarning } from "../hooks/useOriginKeyWarning";
import { AlertTriangle, X, ArrowRight } from "lucide-react";

export function OriginKeyWarningBanner() {
  const { hasOriginMismatch, canonicalOrigin, currentOrigin, dismiss, migrateToCurrentOrigin } =
    useOriginKeyWarning();

  if (!hasOriginMismatch) return null;

  return (
    <div className="bg-amber-900/40 border-b border-amber-700/50 px-4 py-3">
      <div className="max-w-7xl mx-auto flex items-start gap-3">
        <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-amber-200">
            Origin mismatch detected — your stealth keys may differ from your registered identity
          </p>
          <p className="text-xs text-amber-300/80 mt-1">
            Keys were derived on{" "}
            <code className="bg-amber-800/50 px-1 rounded">{canonicalOrigin}</code> but you are now on{" "}
            <code className="bg-amber-800/50 px-1 rounded">{currentOrigin}</code>. Payments sent to
            your old meta-address may not appear here.
          </p>
          <div className="flex items-center gap-2 mt-2">
            <button
              onClick={migrateToCurrentOrigin}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-amber-600 hover:bg-amber-500 text-white rounded-lg transition-colors"
            >
              Derive keys for this origin
              <ArrowRight className="w-3 h-3" />
            </button>
            <a
              href="/docs/key-management"
              className="text-xs text-amber-300/80 hover:text-amber-200 underline"
            >
              Learn about origin binding
            </a>
          </div>
        </div>
        <button
          onClick={dismiss}
          className="p-1 hover:bg-amber-800/50 rounded transition-colors shrink-0"
        >
          <X className="w-4 h-4 text-amber-400" />
        </button>
      </div>
    </div>
  );
}
