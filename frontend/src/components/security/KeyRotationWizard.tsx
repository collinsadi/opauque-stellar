import React, { useState } from "react";
import { KeyRotationManager } from "../../services/keyRotationManager";

export const KeyRotationWizard: React.FC = () => {
  const steps = KeyRotationManager.getMigrationSteps();
  const [currentStep, setCurrentStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [newAddress, setNewAddress] = useState<string | null>(null);

  const handleNext = async () => {
    setLoading(true);
    try {
      if (currentStep === 1) {
        // Step 1: Generate new address
        const addr = await KeyRotationManager.generateNewMetaAddress("OLD_ADDRESS_MOCK");
        setNewAddress(addr);
      }
      
      if (currentStep < steps.length) {
        setCurrentStep(prev => prev + 1);
      } else {
        // Final step
        alert("Key rotation completed successfully.");
        setCurrentStep(1);
        setNewAddress(null);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-white p-6 rounded-lg shadow-md border border-gray-200">
      <h3 className="text-xl font-bold mb-4">Key Rotation & Migration</h3>
      <p className="text-gray-600 mb-6 text-sm">
        If you suspect your stealth keys are compromised, you can rotate to a new meta-address. Old funds will remain recoverable.
      </p>

      <div className="flex mb-8 justify-between">
        {steps.map((step) => (
          <div key={step.id} className={`flex-1 text-center text-sm font-semibold ${currentStep === step.id ? 'text-indigo-600' : currentStep > step.id ? 'text-green-600' : 'text-gray-400'}`}>
            <div className={`mx-auto w-8 h-8 rounded-full flex items-center justify-center mb-2 ${currentStep === step.id ? 'bg-indigo-100' : currentStep > step.id ? 'bg-green-100' : 'bg-gray-100'}`}>
              {step.id}
            </div>
            {step.title}
          </div>
        ))}
      </div>

      <div className="bg-gray-50 p-4 rounded mb-6 min-h-[100px] flex items-center justify-center">
        {currentStep === 1 && <p>Click next to generate a new secure meta-address.</p>}
        {currentStep === 2 && (
          <div className="text-center">
            <p>Your new address has been generated.</p>
            <p className="font-mono bg-white px-2 py-1 border rounded mt-2">{newAddress}</p>
            <p className="mt-4 text-sm">Please proceed to export a new backup.</p>
          </div>
        )}
        {currentStep === 3 && <p>Updating the on-chain registry to mark your old address as legacy...</p>}
        {currentStep === 4 && <p>Now you should notify your frequent contacts to use your new address.</p>}
        {currentStep === 5 && <p>Confirm cutover. Future funds will arrive at your new address.</p>}
      </div>

      <div className="flex justify-end">
        <button
          onClick={handleNext}
          disabled={loading}
          className="bg-indigo-600 text-white font-bold py-2 px-6 rounded hover:bg-indigo-700 transition"
        >
          {loading ? "Processing..." : currentStep === steps.length ? "Complete Migration" : "Next Step"}
        </button>
      </div>
    </div>
  );
};
