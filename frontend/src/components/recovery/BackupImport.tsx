import React, { useState } from "react";
import { RecoveryManager, BackupFile } from "../../services/recoveryManager";

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
    } catch (err: any) {
      setError(err.message || "Failed to import backup.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-white p-6 rounded-lg shadow-md border border-gray-200">
      <h3 className="text-xl font-bold mb-4">Import Recovery Backup</h3>
      <p className="text-gray-600 mb-6 text-sm">
        Restore your keys from a previously exported `.opq` backup file.
      </p>
      
      {success ? (
        <div className="bg-green-100 text-green-800 p-4 rounded mb-4">
          ✅ Backup restored successfully.
        </div>
      ) : (
        <form onSubmit={handleImport} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700">Backup File (.opq)</label>
            <input
              type="file"
              accept=".opq,.json"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
              className="mt-1 block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded file:border-0 file:bg-indigo-50 file:text-indigo-700 hover:file:bg-indigo-100"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm p-2 border"
              required
            />
          </div>
          {error && <p className="text-red-600 text-sm">{error}</p>}
          <button
            type="submit"
            disabled={loading || !file || !password}
            className="w-full bg-indigo-600 text-white font-bold py-2 px-4 rounded hover:bg-indigo-700 transition disabled:bg-gray-400"
          >
            {loading ? "Decrypting..." : "Restore Backup"}
          </button>
        </form>
      )}
    </div>
  );
};
