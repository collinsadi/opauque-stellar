import React, { useEffect, useState } from "react";
import { NetworkValidationService } from "../../services/networkValidation";
import { useSecurityStore } from "../../store/securityStore";

export const NetworkMismatchModal: React.FC = () => {
  const { expectedNetwork } = useSecurityStore();
  const [actualNetwork, setActualNetwork] = useState<string | null>(null);
  const [mismatch, setMismatch] = useState(false);

  const checkNetwork = async () => {
    try {
      const validation = await NetworkValidationService.validateWalletContext();
      setMismatch(!validation.valid);
      setActualNetwork(validation.actual);
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    checkNetwork();
    // In a real app we might poll or listen to wallet events
    const interval = setInterval(checkNetwork, 5000);
    return () => clearInterval(interval);
  }, [expectedNetwork]);

  if (!mismatch) return null;

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-[110]">
      <div className="bg-white text-gray-900 rounded-lg p-6 max-w-md w-full shadow-2xl text-center">
        <div className="text-4xl mb-4">🚫</div>
        <h2 className="text-2xl font-bold mb-4">Network Mismatch Detected</h2>
        <div className="bg-gray-100 p-4 rounded mb-6 text-left">
          <p><strong>Expected Network:</strong> <span className="uppercase text-indigo-600">{expectedNetwork}</span></p>
          <p><strong>Wallet Network:</strong> <span className="uppercase text-red-600">{actualNetwork || "Unknown"}</span></p>
        </div>
        <p className="mb-6 text-sm text-gray-600">
          Please open your Freighter wallet extension and switch to the correct network.
        </p>
        <button
          onClick={checkNetwork}
          className="w-full py-2 bg-indigo-600 text-white rounded font-bold hover:bg-indigo-700 transition-colors"
        >
          Retry Connection
        </button>
      </div>
    </div>
  );
};
