import React, { useState } from "react";
import { RecoveryManager, type BackupFile } from "../../services/recoveryManager";

export const BackupImport: React.FC = () => {
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleImport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file || !password) return;

    setLoading(true);
    setError(null);
    setSuccess(false);

    try {
      const text = await file.text();
      const backupFile: BackupFile = JSON.parse(text);
      
      if (!backupFile.encrypted_payload || !backupFile.salt || !backupFile.nonce) {
        throw new Error("Invalid backup file format.");
      }

      const payload = await RecoveryManager.importBackup(password, backupFile);
      // In a real app, populate stores with the imported payload here.
      console.log("Restored payload:", payload);
      setSuccess(true);
      setFile(null);
      setPassword("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to import backup.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-ink-900 p-6 rounded-lg shadow-md border border-ink-700">
      <h3 className="text-xl font-bold mb-4">Import Recovery Backup</h3>
      <p className="text-mist mb-6 text-sm">
        Restore your keys from a previously exported `.opq` backup file.
      </p>
      
      {success ? (
        <div className="bg-success/10 text-success p-4 rounded mb-4">
          ✅ Backup restored successfully.
        </div>
      ) : (
        <form onSubmit={handleImport} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-mist">Backup File (.opq)</label>
            <input
              type="file"
              accept=".opq,.json"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
              className="mt-1 block w-full text-sm text-white/50 file:mr-4 file:py-2 file:px-4 file:rounded file:border-0 file:bg-ink-800 file:text-mist hover:file:bg-ink-700"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-mist">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 block w-full rounded-md border-ink-600 shadow-sm p-2 border"
              required
            />
          </div>
          {error && <p className="text-neutral-500 text-sm">{error}</p>}
          <button
            type="submit"
            disabled={loading || !file || !password}
            className="w-full bg-neutral-600 text-white font-bold py-2 px-4 rounded hover:bg-neutral-700 transition disabled:opacity-40"
          >
            {loading ? "Decrypting..." : "Restore Backup"}
          </button>
        </form>
      )}
    </div>
  );
};
