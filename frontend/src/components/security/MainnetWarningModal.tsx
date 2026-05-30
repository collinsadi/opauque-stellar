import React, { useState } from "react";
import { Link } from "react-router-dom";
import {
  canProceedToMainnet,
  MAINNET_LEGAL_DOCS,
  requiresMainnetLegalAck,
} from "../../lib/mainnetLegal";
import { useSecurityStore } from "../../store/securityStore";

export const MainnetWarningModal: React.FC = () => {
  const { expectedNetwork, hasAcknowledgedMainnetRisk, setHasAcknowledgedMainnetRisk } =
    useSecurityStore();
  const [legalAccepted, setLegalAccepted] = useState(false);
  const [fundsUnderstood, setFundsUnderstood] = useState(false);

  if (!requiresMainnetLegalAck({ expectedNetwork, hasAcknowledgedMainnetRisk })) return null;

  const canProceed = canProceedToMainnet(legalAccepted, fundsUnderstood);

  const handleConfirm = () => {
    if (canProceed) {
      setHasAcknowledgedMainnetRisk(true);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-[100] p-4">
      <div className="bg-white text-gray-900 rounded-lg p-6 max-w-lg w-full shadow-2xl">
        <h2 className="text-2xl font-bold text-red-600 mb-4">Mainnet Warning</h2>
        <p className="mb-4 text-sm leading-relaxed">
          You are connecting to Stellar Mainnet. Privacy payment features here use{" "}
          <strong>real XLM</strong>. Transactions are irreversible; account reserves and fees
          consume real funds. Review the legal documents below before proceeding.
        </p>

        <div className="mb-4 rounded-md border border-gray-200 bg-gray-50 p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-600 mb-2">
            Required reading
          </p>
          <ul className="space-y-1 text-sm">
            {MAINNET_LEGAL_DOCS.map(({ path, label }) => (
              <li key={path}>
                <Link
                  to={path}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-red-700 font-medium underline hover:text-red-800"
                >
                  {label}
                </Link>
              </li>
            ))}
          </ul>
        </div>

        <div className="mb-4 space-y-3">
          <div className="flex items-start space-x-2">
            <input
              type="checkbox"
              id="legal-accepted"
              checked={legalAccepted}
              onChange={(e) => setLegalAccepted(e.target.checked)}
              className="mt-0.5 w-5 h-5 accent-red-600 shrink-0"
            />
            <label htmlFor="legal-accepted" className="text-sm font-semibold cursor-pointer">
              I have read and agree to the Terms of Service, Privacy Policy, and Disclaimer,
              including mainnet privacy payment use, jurisdictional restrictions, and acceptable
              use.
            </label>
          </div>
          <div className="flex items-start space-x-2">
            <input
              type="checkbox"
              id="funds-understood"
              checked={fundsUnderstood}
              onChange={(e) => setFundsUnderstood(e.target.checked)}
              className="mt-0.5 w-5 h-5 accent-red-600 shrink-0"
            />
            <label htmlFor="funds-understood" className="text-sm font-semibold cursor-pointer">
              I understand I am using mainnet and real funds are at risk.
            </label>
          </div>
        </div>

        <button
          type="button"
          onClick={handleConfirm}
          disabled={!canProceed}
          className={`w-full py-2 rounded font-bold transition-colors ${
            canProceed
              ? "bg-red-600 text-white hover:bg-red-700"
              : "bg-gray-300 text-gray-500 cursor-not-allowed"
          }`}
        >
          Proceed to Mainnet
        </button>
      </div>
    </div>
  );
};
