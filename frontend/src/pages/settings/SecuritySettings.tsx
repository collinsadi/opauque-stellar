import React from "react";
import { BackupExport } from "../../components/recovery/BackupExport";
import { BackupImport } from "../../components/recovery/BackupImport";
import { KeyRotationWizard } from "../../components/security/KeyRotationWizard";
import { formatClipboardClearTimeout, normalizeClipboardClearTimeoutMs } from "../../lib/clipboardSafety";
import { useSecurityStore } from "../../store/securityStore";
import {
  hasCompletedOnboardingTour,
  hasSkippedOnboardingTour,
  resetOnboardingTour,
  runOnboardingTour,
} from "../../lib/onboardingTour";

const OnboardingTourControls: React.FC = () => {
  const [, force] = React.useReducer((x) => x + 1, 0);
  const completed = hasCompletedOnboardingTour();
  const skipped = hasSkippedOnboardingTour();

  const status = completed
    ? "Completed"
    : skipped
      ? "Skipped — not shown on next connect"
      : "Not started";

  return (
    <div className="rounded-xl border border-ink-700 bg-ink-900/60 p-5 space-y-3">
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="font-medium text-white">Onboarding tour</div>
          <div className="text-sm text-mist">Status: {status}</div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              resetOnboardingTour();
              runOnboardingTour(true);
              force();
            }}
            className="rounded-lg border border-white/20 px-3 py-1.5 text-sm text-white hover:bg-ink-800"
          >
            Replay tour
          </button>
          {!skipped && !completed && (
            <button
              type="button"
              onClick={() => {
                try {
                  localStorage.setItem("opaque-tour-skipped", "1");
                } catch {
                  // ignore
                }
                force();
              }}
              className="rounded-lg border border-white/10 px-3 py-1.5 text-sm text-mist hover:text-white"
            >
              Skip
            </button>
          )}
        </div>
      </div>
      <p className="text-xs text-mist/70">
        The tour walks first-time users through connect, register, receive, and scan.
        Replay any time; it never overlays a critical security warning.
      </p>
    </div>
  );
};

const ClipboardSafetyControls: React.FC = () => {
  const sensitiveCopyWarningEnabled = useSecurityStore((s) => s.sensitiveCopyWarningEnabled);
  const clipboardClearTimeoutMs = useSecurityStore((s) => s.clipboardClearTimeoutMs);
  const setSensitiveCopyWarningEnabled = useSecurityStore((s) => s.setSensitiveCopyWarningEnabled);
  const setClipboardClearTimeoutMs = useSecurityStore((s) => s.setClipboardClearTimeoutMs);

  return (
    <div className="rounded-xl border border-ink-700 bg-ink-900/60 p-5 space-y-4">
      <div>
        <div className="font-medium text-white">Sensitive clipboard safety</div>
        <p className="mt-1 text-sm text-mist">
          Default: warn before copying meta-addresses and payment links, then clear the clipboard after {formatClipboardClearTimeout(clipboardClearTimeoutMs)}.
        </p>
      </div>
      <label className="flex items-start gap-3 text-sm text-mist">
        <input
          type="checkbox"
          checked={sensitiveCopyWarningEnabled}
          onChange={(event) => setSensitiveCopyWarningEnabled(event.target.checked)}
          className="mt-1 h-4 w-4 rounded border-ink-600 bg-ink-950"
        />
        <span>Show a warning modal before copying sensitive receive values.</span>
      </label>
      <label className="block text-sm text-mist">
        Clipboard clear timeout
        <select
          value={normalizeClipboardClearTimeoutMs(clipboardClearTimeoutMs)}
          onChange={(event) => setClipboardClearTimeoutMs(Number(event.target.value))}
          className="mt-2 w-full rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 text-white"
        >
          <option value={5000}>5 seconds</option>
          <option value={15000}>15 seconds</option>
          <option value={30000}>30 seconds</option>
          <option value={60000}>1 minute</option>
          <option value={300000}>5 minutes</option>
        </select>
      </label>
      <p className="text-xs text-mist/70">
        Clipboard clearing is best-effort. Browsers may block background clipboard writes, so avoid pasting sensitive values into untrusted apps.
      </p>
    </div>
  );
};

export const SecuritySettings: React.FC = () => {
  return (
    <div className="max-w-4xl mx-auto py-8 px-4">
      <h1 className="text-3xl font-bold mb-8">Security & Recovery Settings</h1>

      <div className="space-y-8">
        <section>
          <h2 className="text-2xl font-semibold mb-4">Backup & Restore</h2>
          <div className="grid md:grid-cols-2 gap-6">
            <BackupExport />
            <BackupImport />
          </div>
        </section>

        <section>
          <h2 className="text-2xl font-semibold mb-4">Clipboard Safety</h2>
          <ClipboardSafetyControls />
        </section>

        <section>
          <h2 className="text-2xl font-semibold mb-4">Account Migration</h2>
          <KeyRotationWizard />
        </section>

        <section>
          <h2 className="text-2xl font-semibold mb-4">Onboarding</h2>
          <OnboardingTourControls />
        </section>
      </div>
    </div>
  );
};
