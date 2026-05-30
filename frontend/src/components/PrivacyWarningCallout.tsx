import { Link } from "react-router-dom";
import { THREAT_MODEL_ROUTE } from "../lib/privacyThreatModel";

type PrivacyWarningCalloutProps = {
  message: string;
  className?: string;
};

export function PrivacyWarningCallout({ message, className = "" }: PrivacyWarningCalloutProps) {
  return (
    <div
      className={`rounded-xl border border-amber-500/30 bg-amber-950/20 px-4 py-3 text-sm text-amber-100/90 ${className}`}
      role="note"
    >
      <p className="leading-relaxed">
        <span className="font-semibold text-amber-200">Privacy note: </span>
        {message}{" "}
        <Link
          to={THREAT_MODEL_ROUTE}
          className="font-medium text-amber-200 underline hover:text-amber-100"
        >
          Threat model
        </Link>
      </p>
    </div>
  );
}
