import { useEffect } from "react";
import { getNetwork } from "../../lib/chain";
import { useSecurityStore } from "../../store/securityStore";
import { MainnetSafetyBanner } from "./MainnetSafetyBanner";
import { MainnetWarningModal } from "./MainnetWarningModal";

/** Syncs configured network to security store and renders mainnet safety UI globally. */
export function MainnetSecurityLayer() {
  const setExpectedNetwork = useSecurityStore((s) => s.setExpectedNetwork);

  useEffect(() => {
    setExpectedNetwork(getNetwork());
  }, [setExpectedNetwork]);

  return (
    <>
      <MainnetSafetyBanner />
      <MainnetWarningModal />
    </>
  );
}
