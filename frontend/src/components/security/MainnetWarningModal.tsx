import React, { useState } from "react";
import { Link } from "react-router-dom";
import { MAINNET_PRIVACY_WARNINGS, THREAT_MODEL_ROUTE } from "../../lib/privacyThreatModel";
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

        <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm">
          <p className="font-semibold text-amber-900 mb-2">Privacy limits on mainnet</p>
          <ul className="list-disc pl-4 space-y-1 text-amber-950/90">
            {MAINNET_PRIVACY_WARNINGS.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <p className="mt-2">
            <Link
              to={THREAT_MODEL_ROUTE}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-amber-900 underline hover:text-amber-950"
            >
              Full privacy threat model
            </Link>
          </p>
        </div>

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
