import "./polyfills";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route, useNavigate } from "react-router-dom";
import "./index.css";
import App from "./App.tsx";
import { KeysProvider } from "./context/KeysContext";
import { NotFoundPage } from "./components/NotFoundPage.tsx";
import { PrivacyPage } from "./components/PrivacyPage.tsx";
import { TermsPage } from "./components/TermsPage.tsx";
import { DisclaimerPage } from "./components/DisclaimerPage.tsx";
import { PayPage } from "./components/PayPage.tsx";
import { PaySuccessPage } from "./components/PaySuccessPage.tsx";
import { getConfiguredNetwork, getNetworkEnvValue } from "./lib/chain.ts";
import { isClusterSupported } from "./contracts/contract-config.ts";
import { LandingPage } from "./components/LandingPage.tsx";
import { BrandingPage } from "./components/BrandingPage.tsx";
import { StellarWalletProviders } from "./context/StellarWalletProviders.tsx";
import { logExpectedArtifactHashes } from "./lib/artifactHashes.ts";

console.log("[Opaque] App bootstrapping (Stellar)…");
logExpectedArtifactHashes();

const network = getConfiguredNetwork();
if (!isClusterSupported(network)) {
  console.warn("[Opaque] Unsupported network:", { network: getNetworkEnvValue() });
} else {
  console.log("[Opaque] Network OK", { network });
}

function LandingRoute() {
  const navigate = useNavigate();
  return <LandingPage onEnterVault={() => navigate("/app")} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <StellarWalletProviders>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<LandingRoute />} />
          <Route path="/app" element={<App />} />
          <Route path="/privacy" element={<PrivacyPage />} />
          <Route path="/terms" element={<TermsPage />} />
          <Route path="/disclaimer" element={<DisclaimerPage />} />
          <Route path="/pay/success" element={<PaySuccessPage />} />
          <Route path="/pay/:identifier" element={<KeysProvider><PayPage /></KeysProvider>} />
          <Route path="/branding" element={<BrandingPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </BrowserRouter>
    </StellarWalletProviders>
  </StrictMode>,
);
