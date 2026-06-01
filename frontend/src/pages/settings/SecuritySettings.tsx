import React from "react";
import { BackupExport } from "../../components/recovery/BackupExport";
import { BackupImport } from "../../components/recovery/BackupImport";
import { KeyRotationWizard } from "../../components/security/KeyRotationWizard";
import { PrivacyDataPanel } from "../../components/PrivacyDataPanel";

type SecuritySettingsProps = {
  onAfterPrivacyWipe?: () => void;
};

export const SecuritySettings: React.FC<SecuritySettingsProps> = ({
  onAfterPrivacyWipe,
}) => {
  return (
    <div className="max-w-4xl mx-auto py-8 px-4">
      <h1 className="text-3xl font-bold mb-8">Security & Recovery Settings</h1>
      
      <div className="space-y-8">
        <PrivacyDataPanel onDisconnect={onAfterPrivacyWipe} />

        <section>
          <h2 className="text-2xl font-semibold mb-4">Backup & Restore</h2>
          <div className="grid md:grid-cols-2 gap-6">
            <BackupExport />
            <BackupImport />
          </div>
        </section>

        <section>
          <h2 className="text-2xl font-semibold mb-4">Account Migration</h2>
          <KeyRotationWizard />
        </section>
      </div>
    </div>
  );
};
