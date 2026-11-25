/**
 * Session timeout settings control (#488).
 *
 * Lets the user configure the idle lock: enable/disable it and pick the idle
 * duration. The persisted encrypted backup is never affected by this setting.
 */

import { useSessionStore, IDLE_TIMEOUT_OPTIONS, type IdleTimeoutMinutes } from "../../store/sessionStore";

export function SessionTimeoutSettings() {
  const idleTimeoutEnabled = useSessionStore((s) => s.idleTimeoutEnabled);
  const idleTimeoutMinutes = useSessionStore((s) => s.idleTimeoutMinutes);
  const setIdleTimeoutEnabled = useSessionStore((s) => s.setIdleTimeoutEnabled);
  const setMinutes = useSessionStore((s) => s.setIdleTimeoutMinutes);

  return (
    <div className="rounded-2xl border border-ink-700 bg-ink-900/60 p-5">
      <h3 className="text-lg font-semibold text-white">Wallet session timeout</h3>
      <p className="mt-1 max-w-prose text-sm leading-relaxed text-mist/70">
        After this period of inactivity while your wallet is connected, sensitive
        views are locked and your ephemeral session keys are cleared. You must
        reconnect to continue. Your encrypted backup is never deleted.
      </p>

      <label className="mt-4 flex cursor-pointer items-center gap-2 text-sm text-white">
        <input
          type="checkbox"
          checked={idleTimeoutEnabled}
          onChange={(e) => setIdleTimeoutEnabled(e.target.checked)}
          className="h-4 w-4 accent-glow"
        />
        Enable idle session lock
      </label>

      <fieldset
        className="mt-4 space-y-2"
        disabled={!idleTimeoutEnabled}
        aria-disabled={!idleTimeoutEnabled}
      >
        <legend className="sr-only">Idle duration before lock</legend>
        {IDLE_TIMEOUT_OPTIONS.map((opt) => (
          <label
            key={opt.value}
            className="flex cursor-pointer items-center gap-2 text-sm text-white disabled:opacity-40"
          >
            <input
              type="radio"
              name="idle-timeout"
              value={opt.value}
              checked={idleTimeoutMinutes === opt.value}
              onChange={() => setMinutes(opt.value as IdleTimeoutMinutes)}
              className="h-4 w-4 accent-glow"
            />
            {opt.label}
          </label>
        ))}
      </fieldset>

      <p className="mt-3 text-xs text-mist/60">
        Currently {idleTimeoutEnabled && idleTimeoutMinutes > 0
          ? `locking after ${idleTimeoutMinutes} minutes of inactivity`
          : "disabled"}
        .
      </p>
    </div>
  );
}
