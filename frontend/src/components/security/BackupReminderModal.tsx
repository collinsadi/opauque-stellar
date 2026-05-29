import React, { useState } from "react";
import { useSecurityStore } from "../../store/securityStore";

export const BackupReminderModal: React.FC<{ type: "send" | "receive"; onProceed: () => void; onCancel: () => void }> = ({ type, onProceed, onCancel }) => {
  const { hasBackedUp, hasAcknowledgedReceiveRisk, setHasAcknowledgedReceiveRisk } = useSecurityStore();
  const [understood, setUnderstood] = useState(false);

  // If it's a send flow and they haven't backed up, force them to acknowledge they backed up (or just acknowledge)
  // If it's receive flow and they haven't acknowledged, force them to acknowledge.
  
  if (type === "send" && hasBackedUp) return null;
  if (type === "receive" && hasAcknowledgedReceiveRisk) return null;

  const handleConfirm = () => {
    if (understood) {
      if (type === "receive") setHasAcknowledgedReceiveRisk(true);
      // For send, we might not set hasBackedUp here, they might just acknowledge risk, but the prompt says:
      // First Send Flow: Require acknowledgement: "I have backed up my stealth recovery data."
      // First Receive Flow: Require acknowledgement: "I understand funds may be unrecoverable without backups."
      onProceed();
    }
  };

  const message = type === "send"
    ? "I have backed up my stealth recovery data."
    : "I understand funds may be unrecoverable without backups.";

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[90]">
      <div className="bg-white text-gray-900 rounded-lg p-6 max-w-md w-full shadow-2xl">
        <h2 className="text-xl font-bold mb-4">⚠️ Backup Reminder</h2>
        <p className="mb-6 text-gray-600">
          Stealth address recovery relies entirely on your local keys. Without a backup, if you lose your device, your funds are permanently lost.
        </p>
        <div className="mb-6 flex items-start space-x-3">
          <input
            type="checkbox"
            id="backup-ack"
            checked={understood}
            onChange={(e) => setUnderstood(e.target.checked)}
            className="w-5 h-5 mt-1 accent-indigo-600"
          />
          <label htmlFor="backup-ack" className="font-semibold cursor-pointer text-sm">
            {message}
          </label>
        </div>
        <div className="flex space-x-4">
          <button
            onClick={onCancel}
            className="flex-1 py-2 rounded font-medium bg-gray-200 hover:bg-gray-300 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={!understood}
            className={`flex-1 py-2 rounded font-bold transition-colors ${
              understood ? "bg-indigo-600 text-white hover:bg-indigo-700" : "bg-indigo-300 text-white cursor-not-allowed"
            }`}
          >
            Proceed
          </button>
        </div>
      </div>
    </div>
  );
};
