import { useEffect, useState, type ReactNode } from "react";
import {
  assessBrowserSupport,
  unsupportedBrowserMessage,
  type BrowserSupportAssessment,
} from "../lib/browserSupport";

type Props = { children: ReactNode };

export function BrowserGuard({ children }: Props) {
  const [assessment, setAssessment] = useState<BrowserSupportAssessment | null>(
    null,
  );

  useEffect(() => {
    setAssessment(assessBrowserSupport());
  }, []);

  if (!assessment) return <>{children}</>;

  if (assessment.level === "unsupported") {
    return (
      <div className="min-h-dvh flex items-center justify-center bg-ink-950 p-6">
        <div className="max-w-md rounded-2xl border border-error/40 bg-ink-900/80 p-6 text-center">
          <h1 className="font-display text-xl font-bold text-white mb-3">
            Browser not supported
          </h1>
          <p className="text-sm text-mist leading-relaxed">
            {unsupportedBrowserMessage(assessment)}
          </p>
          <p className="mt-4 text-xs text-mist/70">
            See{" "}
            <a
              href="https://github.com/collinsadi/opaque-stellar/blob/main/docs/BROWSER_SUPPORT.md"
              className="text-sol-purple hover:underline"
              target="_blank"
              rel="noopener noreferrer"
            >
              browser support matrix
            </a>{" "}
            for tested configurations.
          </p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}

export function BrowserSupportBanner() {
  const [assessment, setAssessment] = useState<BrowserSupportAssessment | null>(
    null,
  );

  useEffect(() => {
    setAssessment(assessBrowserSupport());
  }, []);

  if (!assessment || assessment.level === "supported") return null;
  if (assessment.warnings.length === 0) return null;

  return (
    <div
      role="status"
      className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-center text-xs text-amber-100 space-y-0.5"
    >
      {assessment.warnings.map((warning) => (
        <p key={warning}>{warning}</p>
      ))}
    </div>
  );
}
