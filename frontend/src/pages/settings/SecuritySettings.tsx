import React from "react";
import { BackupExport } from "../../components/recovery/BackupExport";
import { BackupImport } from "../../components/recovery/BackupImport";
import { KeyRotationWizard } from "../../components/security/KeyRotationWizard";
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
