import {
  FEATURE_FLAG_ENV,
  FEATURE_LABELS,
  type FeatureFlagKey,
} from "../lib/featureFlags";
import { getNetwork } from "../lib/chain";

type FeatureDisabledNoticeProps = {
  feature: FeatureFlagKey;
  readOnly?: boolean;
};

export function FeatureDisabledNotice({ feature, readOnly = false }: FeatureDisabledNoticeProps) {
  const network = getNetwork();
  const envKey = FEATURE_FLAG_ENV[feature];
  const label = FEATURE_LABELS[feature];

  return (
    <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 px-5 py-4 text-sm">
      <p className="font-semibold text-amber-200">
        {readOnly ? `${label} — read-only` : `${label} — disabled`}
      </p>
      <p className="mt-2 text-amber-200/80 text-xs leading-relaxed">
        {readOnly
          ? "This deployment shows existing data but write actions are disabled."
          : "This feature is not enabled on this deployment."}
        {network === "mainnet" && (
          <>
            {" "}
            Mainnet builds require an explicit{" "}
            <code className="rounded bg-ink-900/60 px-1 py-0.5 font-mono text-[11px]">{envKey}=true</code>{" "}
            at build time. See{" "}
            <a
              href="https://github.com/collinsadi/opaque-stellar/blob/main/docs/FEATURE_FLAGS.md"
              target="_blank"
              rel="noopener noreferrer"
              className="text-amber-100 underline hover:text-white"
            >
              feature flags documentation
            </a>
            .
          </>
        )}
      </p>
    </div>
  );
}
