import React, { useState } from "react";
import { KeyRotationManager } from "../../services/keyRotationManager";
import { useKeys } from "../../context/KeysContext";

function useCurrentMetaAddress(): string {
  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const { stealthMetaAddressHex } = useKeys();
    return stealthMetaAddressHex ?? "";
  } catch {
    // Outside KeysProvider (e.g. tests); proceed with empty string
    return "";
  }
}

export const KeyRotationWizard: React.FC = () => {
  const steps = KeyRotationManager.getMigrationSteps();
  const currentMetaAddress = useCurrentMetaAddress();

  const [currentStep, setCurrentStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [newAddress, setNewAddress] = useState<string | null>(null);
  const [backupPassword, setBackupPassword] = useState("");
  const [backupError, setBackupError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const handleExportBackup = async () => {
    if (!newAddress) return;
    setBackupError(null);
    setLoading(true);
    try {
      await KeyRotationManager.exportRotationBackup(
        backupPassword,
        currentMetaAddress,
        newAddress,
      );
    } catch (e) {
      setBackupError(e instanceof Error ? e.message : "Backup export failed");
    } finally {
      setLoading(false);
    }
  };

  const handleNext = async () => {
    setLoading(true);
    try {
      if (currentStep === 1) {
        const addr = await KeyRotationManager.generateNewMetaAddress(currentMetaAddress);
        setNewAddress(addr);
      }

      if (currentStep === 2) {
        // Mark the old address as legacy before advancing so it can still sweep pending ghosts
        KeyRotationManager.markAddressAsLegacy(currentMetaAddress);
      }

      if (currentStep < steps.length) {
        setCurrentStep((prev) => prev + 1);
      } else {
        setDone(true);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleReset = () => {
    setDone(false);
    setCurrentStep(1);
    setNewAddress(null);
    setBackupPassword("");
    setBackupError(null);
  };

  if (done) {
    return (
      <div className="rounded-2xl border border-ink-700 bg-ink-900/25 p-6 text-center">
        <p className="font-display text-lg font-bold text-white mb-1">
          Key rotation complete
        </p>
        <p className="text-sm text-mist mt-2">
          Your old address has been marked as legacy — any pending ghost funds sent
          to it will still be sweepable. Share your new address with contacts for
          future private sends.
        </p>
        {newAddress && (
          <p className="mt-4 font-mono text-xs text-mist break-all border border-ink-700 bg-ink-800/60 rounded-xl px-3 py-2">
            {newAddress}
          </p>
        )}
        <button
          type="button"
          onClick={handleReset}
          className="mt-5 rounded-xl border border-ink-600 bg-ink-950/30 px-4 py-2 text-sm font-medium text-mist transition-colors hover:border-white/30 hover:text-white"
        >
          Start over
        </button>
      </div>
    );
  }

  return (

    <div className="rounded-2xl border border-ink-700 bg-ink-900 p-6">
      <h3 className="font-display text-xl font-bold text-white mb-2">
        Key Rotation &amp; Migration
      </h3>
      <p className="text-mist mb-6 text-sm">
        If you suspect your stealth keys are compromised, you can rotate to a new
        meta-address. Old funds will remain recoverable.
      </p>

      {/* Step indicator */}
      <div className="flex mb-8 justify-between gap-1">
        {steps.map((step) => {
          const isActive = currentStep === step.id;
          const isCompleted = currentStep > step.id;
          return (
            <div
              key={step.id}
              className={`flex-1 text-center text-xs font-medium ${
                isActive ? "text-white" : isCompleted ? "text-mist" : "text-mist/40"
              }`}
            >
              <div
                className={`mx-auto w-8 h-8 rounded-full flex items-center justify-center mb-1.5 text-xs font-bold border ${
                  isActive
                    ? "border-white bg-white text-black"
                    : isCompleted
                      ? "border-ink-600 bg-ink-700 text-mist"
                      : "border-ink-700 bg-ink-900 text-mist/40"
                }`}
              >
                {isCompleted ? "✓" : step.id}
              </div>
              <span className="hidden sm:inline">{step.title}</span>

    <div className="bg-ink-900 p-6 rounded-lg shadow-md border border-ink-700">
      <h3 className="text-xl font-bold mb-4">Key Rotation & Migration</h3>
      <p className="text-mist mb-6 text-sm">
        If you suspect your stealth keys are compromised, you can rotate to a new meta-address. Old funds will remain recoverable.
      </p>

      <div className="flex mb-8 justify-between">
        {steps.map((step) => (
          <div key={step.id} className={`flex-1 text-center text-sm font-semibold ${currentStep === step.id ? 'text-neutral-500' : currentStep > step.id ? 'text-neutral-500' : 'text-white/60'}`}>
            <div className={`mx-auto w-8 h-8 rounded-full flex items-center justify-center mb-2 ${currentStep === step.id ? 'bg-ink-800' : currentStep > step.id ? 'bg-ink-800' : 'bg-black'}`}>
              {step.id}

            </div>
          );
        })}
      </div>


      {/* Step content */}
      <div className="rounded-xl border border-ink-700 bg-ink-800/60 p-5 min-h-[120px] flex flex-col justify-center mb-6 gap-3">
        {currentStep === 1 && (
          <p className="text-mist text-sm">
            Click next to generate a new secure meta-address.
          </p>
        )}
        {currentStep === 2 && (
          <div className="space-y-3">
            <div>
              <p className="text-white text-sm font-medium mb-1">New address generated</p>
              <p className="font-mono text-xs text-mist break-all border border-ink-700 rounded-lg bg-ink-900 px-3 py-2">
                {newAddress}
              </p>
            </div>
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-mist" htmlFor="backup-password">
                Backup password
              </label>
              <input
                id="backup-password"
                type="password"
                value={backupPassword}
                onChange={(e) => setBackupPassword(e.target.value)}
                placeholder="Enter a strong password"
                className="input-field w-full text-sm"
                disabled={loading}
              />
              {backupError && (
                <p className="text-xs text-neutral-400">{backupError}</p>
              )}
            </div>
            <button
              type="button"
              onClick={() => void handleExportBackup()}
              disabled={loading || !backupPassword}
              className="rounded-xl border border-ink-600 bg-ink-950/30 px-4 py-2 text-sm font-medium text-mist transition-colors hover:border-white/30 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {loading ? "Exporting…" : "Export Backup (.opq)"}
            </button>

      <div className="bg-ink-950 p-4 rounded mb-6 min-h-[100px] flex items-center justify-center">
        {currentStep === 1 && <p>Click next to generate a new secure meta-address.</p>}
        {currentStep === 2 && (
          <div className="text-center">
            <p>Your new address has been generated.</p>
            <p className="font-mono bg-sol-gradient px-2 py-1 border rounded mt-2">{newAddress}</p>
            <p className="mt-4 text-sm">Please proceed to export a new backup.</p>

          </div>
        )}
        {currentStep === 3 && (
          <p className="text-mist text-sm">
            Your old address will be marked as legacy locally. Funds sent to it
            before rotation remain sweepable.
          </p>
        )}
        {currentStep === 4 && (
          <p className="text-mist text-sm">
            Notify your frequent senders to use your new address for future
            private transactions.
          </p>
        )}
        {currentStep === 5 && (
          <p className="text-mist text-sm">
            Confirm cutover. Future funds should arrive at your new address.
          </p>
        )}
      </div>

      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => void handleNext()}
          disabled={loading}
          className="btn-primary px-6 py-2 text-sm font-semibold rounded-xl disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading
            ? "Processing…"
            : currentStep === steps.length
              ? "Complete Migration"
              : "Next Step"}
        </button>
      </div>
    </div>
  );
};
