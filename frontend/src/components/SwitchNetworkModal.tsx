/**
 * Modal informing the user about network configuration.
 * Network switching is done via environment variables, not in-wallet RPC calls.
 */

import { type ReactNode } from "react";
import { getConfiguredNetwork, getNetworkEnvValue } from "../lib/chain";
import {
  getNetworkSupportMessage,
  SUPPORTED_CLUSTERS,
} from "../contracts/contract-config";
import { ModalShell } from "./ModalShell";

export type SwitchNetworkModalProps = {
  title?: string;
  description?: ReactNode;
  onClose?: () => void;
  showClose?: boolean;
};

export function SwitchNetworkModal({
  title = "Switch network",
  description = `Opaque supports ${SUPPORTED_CLUSTERS.join(", ")}. Mainnet also requires production RPC and contract IDs.`,
  onClose,
  showClose = false,
}: SwitchNetworkModalProps) {
  const network = getConfiguredNetwork();

  return (
    <ModalShell
      open
      title={title}
      description={description}
      onClose={() => onClose?.()}
      closeOnBackdrop={Boolean(showClose)}
      maxWidthClassName="max-w-md"
    >
      <div className="flex flex-col gap-3">
        <p className="text-sm text-mist">
          Current network: <span className="text-white font-mono">{getNetworkEnvValue()}</span>
        </p>
        <p className="text-sm text-mist">
          {getNetworkSupportMessage(network)}
        </p>
        <p className="text-sm text-mist">
          To switch networks, set{" "}
          <code className="text-xs bg-ink-900 px-1.5 py-0.5 rounded">VITE_STELLAR_NETWORK</code> in your
          environment and reload the page.
        </p>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="w-full rounded-xl bg-sol-gradient border border-transparent px-4 py-2.5 text-sm font-semibold text-white hover:opacity-90"
          >
            Close
          </button>
        )}
      </div>
    </ModalShell>
  );
}
