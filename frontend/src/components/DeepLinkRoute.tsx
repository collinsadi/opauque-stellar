import { useEffect, useMemo } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { getDeepLinkFromSearch, parseOpaqueDeepLink } from "../lib/deepLinks";

export function DeepLinkRoute() {
  const location = useLocation();
  const navigate = useNavigate();
  const raw = getDeepLinkFromSearch(location.search);
  const result = useMemo(
    () => (raw ? parseOpaqueDeepLink(raw) : { ok: false as const, reason: "No opaque link was provided." }),
    [raw],
  );

  useEffect(() => {
    if (!result.ok) return;
    navigate("/app", { replace: true, state: result.target });
  }, [navigate, result]);

  if (result.ok) {
    return (
      <div className="min-h-screen bg-ink-950 bg-grid-fade bg-size-grid px-4 text-white flex items-center justify-center">
        <div className="card max-w-sm text-center">
          <span className="mx-auto block h-6 w-6 animate-spin rounded-full border-2 border-ink-600 border-t-white" />
          <p className="mt-4 text-sm text-mist">Opening opaque link…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-ink-950 bg-grid-fade bg-size-grid px-4 text-white flex items-center justify-center">
      <div className="card max-w-md text-center">
        <p className="text-xs font-mono text-mist">Opaque link error</p>
        <h1 className="mt-2 font-display text-2xl font-bold">Invalid deep link</h1>
        <p className="mt-3 text-sm text-mist">{result.reason}</p>
        <Link
          to="/app"
          className="mt-6 inline-flex rounded-xl border border-ink-600 bg-ink-900 px-4 py-2 text-sm font-semibold text-white transition-colors hover:border-white/40"
        >
          Return to app
        </Link>
      </div>
    </div>
  );
}
