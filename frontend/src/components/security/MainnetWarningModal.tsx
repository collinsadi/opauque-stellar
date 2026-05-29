import React, { useState } from "react";
import { useSecurityStore } from "../../store/securityStore";

export const MainnetWarningModal: React.FC = () => {
  const { expectedNetwork, hasAcknowledgedMainnetRisk, setHasAcknowledgedMainnetRisk } = useSecurityStore();
  const [understood, setUnderstood] = useState(false);

  if (expectedNetwork !== "mainnet" || hasAcknowledgedMainnetRisk) return null;

  const handleConfirm = () => {
    if (understood) {
      setHasAcknowledgedMainnetRisk(true);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-[100]">
      <div className="bg-white text-gray-900 rounded-lg p-6 max-w-md w-full shadow-2xl">
        <h2 className="text-2xl font-bold text-red-600 mb-4">🚨 Mainnet Warning</h2>
        <p className="mb-4">
          You are connecting to the Stellar Mainnet. Transactions here are irreversible.
          Account creation and network reserves will consume real funds (XLM).
        </p>
        <div className="mb-6 flex items-center space-x-2">
          <input
            type="checkbox"
            id="understood"
            checked={understood}
            onChange={(e) => setUnderstood(e.target.checked)}
            className="w-5 h-5 accent-red-600"
          />
          <label htmlFor="understood" className="font-semibold cursor-pointer">
            I understand I am using mainnet and real funds.
          </label>
        </div>
        <button
          onClick={handleConfirm}
          disabled={!understood}
          className={`w-full py-2 rounded font-bold transition-colors ${
            understood ? "bg-red-600 text-white hover:bg-red-700" : "bg-gray-300 text-gray-500 cursor-not-allowed"
          }`}
        >
          Proceed to Mainnet
        </button>
      </div>
    </div>
  );
};
