import React, { useState } from "react";
import { RecoveryManager, BackupPayload } from "../../services/recoveryManager";
import { useSecurityStore } from "../../store/securityStore";

export const BackupExport: React.FC = () => {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { setHasBackedUp } = useSecurityStore();

  const handleExport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }

    setLoading(true);
    setError(null);
    try {
      // Dummy payload for demonstration. In a real app, gather keys from stores.
      const payload: BackupPayload = {
        stealthMasterKeys: [{ key: "MOCK_KEY" }],
        metaAddresses: [{ address: "MOCK_ADDR" }],
        scanKeys: [],
        ghostEntries: [],
        recoveryMetadata: { timestamp: Date.now() }
      };

      const backup = await RecoveryManager.exportBackup(password, payload);
      RecoveryManager.downloadBackupFile(backup);
      setHasBackedUp(true);
      setPassword("");
      setConfirmPassword("");
    } catch (err: any) {
      setError(err.message || "Failed to export backup.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-white p-6 rounded-lg shadow-md border border-gray-200">
      <h3 className="text-xl font-bold mb-4">Export Recovery Backup</h3>
      <p className="text-gray-600 mb-6 text-sm">
        Securely export your stealth keys and meta-addresses. The file will be encrypted with AES-256-GCM.
      </p>
      <form onSubmit={handleExport} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700">Backup Password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm p-2 border"
            required
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700">Confirm Password</label>
          <input
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm p-2 border"
            required
          />
        </div>
        {error && <p className="text-red-600 text-sm">{error}</p>}
        <button
          type="submit"
          disabled={loading}
          className="w-full bg-indigo-600 text-white font-bold py-2 px-4 rounded hover:bg-indigo-700 transition disabled:bg-indigo-400"
        >
          {loading ? "Encrypting..." : "Download Encrypted Backup"}
        </button>
      </form>
    </div>
  );
};
