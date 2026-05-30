import React, { useState } from "react";
import { Link } from "react-router-dom";
import { MAINNET_PRIVACY_WARNINGS, THREAT_MODEL_ROUTE } from "../../lib/privacyThreatModel";
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
