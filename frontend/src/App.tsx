import { useState, useEffect, useCallback, useRef, lazy, Suspense } from "react";
import { ViewErrorBoundary } from "./components/ViewErrorBoundary";
import { useLocation, useNavigate } from "react-router-dom";
import { MotionConfig } from "framer-motion";
import { usePrefersReducedMotion } from "./hooks/usePrefersReducedMotion";
import { KeysProvider, useKeys } from "./context/KeysContext";
import { hasCompletedOnboardingTour, runOnboardingTour } from "./lib/onboardingTour";
import { ProtocolLogProvider } from "./context/ProtocolLogContext";
import { ToastProvider, useToast } from "./context/ToastContext";
import { LandingView } from "./components/LandingView";
import { DashboardView } from "./components/DashboardView";
import { RegistrationWizard } from "./components/RegistrationWizard";
import { SendView } from "./components/SendView";
import { PrivateBalanceView } from "./components/PrivateBalanceView";
import { TransactionHistoryView } from "./components/TransactionHistoryView";
import { ReceiveView } from "./components/ReceiveView";
import { ProfileView } from "./components/ProfileView";
import { ProtocolLogPanel } from "./components/ProtocolLogPanel";
import { Layout, type Tab } from "./components/Layout";
import { NetworkGuard } from "./components/NetworkGuard";
import { useWallet } from "./hooks/useWallet";
import { useRegistrationStatus } from "./hooks/useRegistrationStatus";
import { useVaultStore } from "./store/vaultStore";
import { useGhostAddressStore, useGhostAddressPersistence, clearGhostPassword } from "./store/ghostAddressStore";
import { useAccountScope } from "./hooks/useAccountScope";
import { useTxHistoryStore } from "./store/txHistoryStore";
import { usePoolNoteStore } from "./store/poolNoteStore";
import { useReputationStore } from "./store/reputationStore";
import { useIssuedAttestationStore } from "./store/issuedAttestationStore";
import { useSchemaStore } from "./store/schemaStore";
import { useGhostAnnouncementStore } from "./store/ghostAnnouncementStore";
import { useWatchlistStore } from "./hooks/useWatchlist";
import { usePendingTxStore } from "./store/pendingTxStore";
import { useSecuritySettingsStore } from "./store/securitySettingsStore";
import { clearAllData as clearIndexedDB } from "./lib/opaqueCache";
import { DisconnectConfirmModal } from "./components/DisconnectConfirmModal";
import { getExplorerTxUrl } from "./lib/explorer";
import { NetworkMismatchModal } from "./components/security/NetworkMismatchModal";
import { SecuritySettings } from "./pages/settings/SecuritySettings";
import { FeatureDisabledNotice } from "./components/FeatureDisabledNotice";
import { getTabAccess } from "./lib/tabAccess";
import { getFeatureFlags } from "./lib/featureFlags";
import { SessionTimeoutProvider } from "./components/security/SessionTimeoutProvider";
import { useHistoryReconciliation } from "./hooks/useHistoryReconciliation";
import { startPendingTxTracking } from "./lib/txTracking";
import { horizonTxStatusFetcher } from "./lib/chainHistoryFetchers";
import { loadSignatureSession } from "./lib/signatureSession";

const SchemaStudio = lazy(() => import("./components/SchemaStudio").then((m) => ({ default: m.SchemaStudio })));
const AttestationManager = lazy(() => import("./components/AttestationManager").then((m) => ({ default: m.AttestationManager })));
const MyTraitsView = lazy(() => import("./components/MyTraitsView").then((m) => ({ default: m.MyTraitsView })));
const ManageView = lazy(() => import("./components/ManageView").then((m) => ({ default: m.ManageView })));
const PoolView = lazy(() => import("./components/PoolView").then((m) => ({ default: m.PoolView })));

/** Stamps the resolved motion preference onto <html> for the CSS kill-switch in index.css. */
function MotionPreferenceEffect() {
  const reduceMotion = usePrefersReducedMotion();

  useEffect(() => {
    document.documentElement.dataset.reduceMotion = reduceMotion ? "true" : "false";
  }, [reduceMotion]);

  return null;
}

function LazyFallback() {
  return (
    <div className="flex items-center justify-center min-h-[30vh]">
      <span className="h-6 w-6 animate-spin rounded-full border-2 border-ink-600 border-t-white" />
    </div>
  );
}

function AppContent() {
  const [tab, setTab] = useState<Tab>("dashboard");
  const [registrationJustCompleted, setRegistrationJustCompleted] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const { isConnected, address, cluster, isConnecting, connect, disconnect } = useWallet();
  const { isSetup, clearKeys, setFromSignature, stealthMetaAddressHex } = useKeys();
  const { isRegistered, isLoading: isRegistrationCheckLoading, error: registrationError, retry: retryRegistrationCheck } = useRegistrationStatus(address, cluster, stealthMetaAddressHex);
  const clearVault = useVaultStore((s) => s.clear);
  const [showDisconnectModal, setShowDisconnectModal] = useState(false);
  const activeWalletRef = useRef(address);

  useEffect(() => {
    if (activeWalletRef.current === address) return;
    activeWalletRef.current = address;
    setRegistrationJustCompleted(false);
    clearKeys({ preserveSession: true });
    if (!address || cluster == null) return;
    let cancelled = false;
    void loadSignatureSession({
      address,
      cluster,
      message: "Sign this message to derive your Opaque Cash stealth keys on Stellar. This is not a transaction and does not move funds.",
    }).then((signature) => {
      if (!cancelled && signature) setFromSignature(signature);
    }).catch(() => {
      // A missing/expired remembered signature falls back to normal setup.
    });
    return () => { cancelled = true; };
  }, [address, cluster, clearKeys, setFromSignature]);

  useGhostAddressPersistence();
  useAccountScope();

  useEffect(() => {
    useGhostAddressStore.getState().sanitizeGhostAddresses();
  }, []);

  // Resume in-flight transactions persisted before a reload (#114).
  useEffect(() => startPendingTxTracking({ fetchStatus: horizonTxStatusFetcher }), []);

  useEffect(() => {
    const requestedTab = (location.state as { tab?: Tab } | null)?.tab;
    if (location.pathname === "/app" && requestedTab) {
      setTab(requestedTab);
      navigate("/app", { replace: true, state: {} });
    }
  }, [location.pathname, location.state, navigate]);

  useEffect(() => {
    setRegistrationJustCompleted(false);
  }, [cluster]);

  const showDashboard = isRegistered || registrationJustCompleted;
  // Fresh device / cleared storage: rebuild history from chain (#113).
  useHistoryReconciliation({
    cluster: cluster ?? "",
    address,
    enabled: isConnected && cluster != null && showDashboard,
    autoOnEmpty: true,
  });

  const showRegistrationWizard = isSetup && isConnected && address && cluster != null && !showDashboard && !isRegistrationCheckLoading;

  const handleRegistrationComplete = useCallback(() => {
    setRegistrationJustCompleted(true);
  }, []);

  const handleTab = (t: Tab) => {
    setTab(t);
  };

  useEffect(() => {
    if (tab !== "dashboard" || !isConnected || !isSetup || hasCompletedOnboardingTour()) return;
    const timer = setTimeout(() => runOnboardingTour(), 600);
    return () => clearTimeout(timer);
  }, [tab, isConnected, isSetup]);

  useEffect(() => {
    if (!registrationJustCompleted || tab !== "dashboard") return;
    const timer = setTimeout(() => runOnboardingTour(true), 800);
    return () => clearTimeout(timer);
  }, [registrationJustCompleted, tab]);

  const handleConnect = useCallback(async () => {
    try {
      await connect();
    } catch (e) {
      console.error("[App] Wallet connect failed:", e);
    }
  }, [connect]);

  const handleDisconnect = () => {
    setShowDisconnectModal(true);
  };

  const executeDisconnect = useCallback(async (fullWipe: boolean) => {
    setShowDisconnectModal(false);
    clearKeys();
    clearVault();
    if (fullWipe) {
      // Clear all persisted stores (all accounts)
      useTxHistoryStore.getState().clear({ allAccounts: true });
      usePoolNoteStore.getState().clear({ allAccounts: true });
      useWatchlistStore.getState().clear({ allAccounts: true });
      useReputationStore.getState().clearTraits();
      useIssuedAttestationStore.setState({ issued: [] });
      useSchemaStore.setState({ schemas: {}, discoveredTraits: {}, attestations: {}, lastScannedSlot: 0 });
      useGhostAnnouncementStore.setState({ keys: {} });
      useGhostAddressStore.getState().setEntries([]);
      usePendingTxStore.setState({ byHash: {} });
      useSecuritySettingsStore.getState().clearPassphrase();
      clearGhostPassword();
      // Clear IndexedDB announcement cache
      try {
        await clearIndexedDB();
      } catch {
        // best-effort
      }
      // Remove all opaque-* localStorage keys
      if (typeof localStorage !== "undefined") {
        const keysToRemove: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key?.startsWith("opaque")) keysToRemove.push(key);
        }
        for (const key of keysToRemove) localStorage.removeItem(key);
      }
    }
    disconnect();
    setTab("dashboard");
  }, [clearKeys, clearVault, disconnect]);

  const renderView = () => {
    const access = getTabAccess(tab);
    if (access === "hidden") {
      const hiddenFeature =
        tab === "pool"
          ? "privacyPool"
          : tab === "schemas" || tab === "attest"
            ? "schemaManagement"
            : "reputationProofs";
      return (
        <div className="max-w-lg mx-auto py-8">
          <FeatureDisabledNotice feature={hiddenFeature} />
        </div>
      );
    }

    if (tab === "dashboard") return <DashboardView onNavigate={setTab} address={address ?? undefined} cluster={cluster} />;
    if (tab === "send") return <SendView />;
    if (tab === "receive") return <ReceiveView onBack={() => setTab("dashboard")} />;
    if (tab === "balance") return <PrivateBalanceView />;
    if (tab === "history") return <TransactionHistoryView />;
    if (tab === "profile") return <ProfileView onNavigate={setTab} onDisconnect={handleDisconnect} />;
    if (tab === "reputation" || tab === "my-traits") {
      return (
        <Suspense fallback={<LazyFallback />}>
          <MyTraitsView onNavigate={setTab} readOnly={access === "readonly"} />
        </Suspense>
      );
    }
    if (tab === "schemas") {
      return (
        <Suspense fallback={<LazyFallback />}>
          <SchemaStudio />
        </Suspense>
      );
    }
    if (tab === "attest") {
      return (
        <Suspense fallback={<LazyFallback />}>
          <AttestationManager onNavigate={setTab} />
        </Suspense>
      );
    }
    if (tab === "manage") {
      return (
        <Suspense fallback={<LazyFallback />}>
          <ManageView onNavigate={setTab} readOnly={access === "readonly"} />
        </Suspense>
      );
    }
    if (tab === "pool") {
      return (
        <Suspense fallback={<LazyFallback />}>
          <PoolView onNavigate={setTab} readOnly={access === "readonly"} />
        </Suspense>
      );
    }
    if (tab === "security") return <SecuritySettings />;
    return null;
  };

  const protocolLogPanel = getFeatureFlags().debugLogs ? <ProtocolLogPanel /> : null;

  if (!isSetup) {
    return (
      <div className="min-h-dvh flex flex-col bg-ink-950 bg-grid-fade bg-size-grid">
        <LandingView />
      </div>
    );
  }

  if (isRegistrationCheckLoading) {
    return (
      <Layout
        tab="dashboard"
        onTabChange={handleTab}
        isConnected={isConnected}
        address={address ?? undefined}
        isConnecting={isConnecting}
        onConnect={handleConnect}
        onDisconnect={handleDisconnect}
        protocolLog={protocolLogPanel}
      >
        <div className="flex flex-col items-center justify-center min-h-[40vh] gap-4">
          <span className="h-7 w-7 animate-spin rounded-full border-2 border-ink-600 border-t-white" aria-hidden />
          <p className="text-sm text-mist">Authenticating with protocol…</p>
        </div>
      </Layout>
    );
  }

  if (registrationError && address && cluster != null && !isRegistered) {
    return (
      <Layout tab="dashboard" onTabChange={handleTab} isConnected={isConnected} address={address ?? undefined}
        isConnecting={isConnecting} onConnect={handleConnect} onDisconnect={handleDisconnect} protocolLog={protocolLogPanel}>
        <div role="alert" className="card max-w-lg mx-auto space-y-3">
          <h2 className="text-lg font-semibold text-white">Registration status unavailable</h2>
          <p className="text-sm text-mist">The registry could not be reached, so onboarding is paused. Try again when the network is available.</p>
          <button type="button" onClick={retryRegistrationCheck} className="btn-primary px-4 py-2 rounded-lg text-sm">Retry registry check</button>
        </div>
      </Layout>
    );
  }

  if (showRegistrationWizard) {
    return (
      <Layout
        tab={tab}
        onTabChange={handleTab}
        isConnected={isConnected}
        address={address ?? undefined}
        isConnecting={isConnecting}
        onConnect={handleConnect}
        onDisconnect={handleDisconnect}
        protocolLog={protocolLogPanel}
      >
        <RegistrationWizard onComplete={handleRegistrationComplete} />
      </Layout>
    );
  }

  return (
    <>
      <Layout
        tab={tab}
        onTabChange={handleTab}
        isConnected={isConnected}
        address={address ?? undefined}
        isConnecting={isConnecting}
        onConnect={handleConnect}
        onDisconnect={handleDisconnect}
        protocolLog={protocolLogPanel}
      >
        <NetworkGuard>
          <ViewErrorBoundary>{renderView()}</ViewErrorBoundary>
        </NetworkGuard>
      </Layout>
      {showDisconnectModal && (
        <DisconnectConfirmModal
          onDisconnectOnly={() => void executeDisconnect(false)}
          onFullWipe={() => void executeDisconnect(true)}
          onCancel={() => setShowDisconnectModal(false)}
        />
      )}
    </>
  );
}

const ExternalLinkIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    <polyline points="15 3 21 3 21 9" />
    <line x1="10" y1="14" x2="21" y2="3" />
  </svg>
);

function ToastLayer() {
  const { toasts, dismiss } = useToast();
  if (toasts.length === 0) return null;
  return (
    <div className="fixed bottom-24 md:bottom-16 left-4 right-4 md:left-auto md:right-6 z-50 flex flex-col gap-2 max-w-sm md:ml-auto">
      {toasts.map((t) => {
        const explorerUrl = t.explorerTx ? getExplorerTxUrl(t.explorerTx.txSig) : null;
        return (
          <div
            key={t.id}
            className="rounded-xl border border-ink-700 bg-ink-900/95 px-4 py-3 text-sm text-white shadow-2xl backdrop-blur-lg flex flex-wrap items-center justify-between gap-2"
          >
            <span className="min-w-0 flex-1">{t.message}</span>
            <div className="flex items-center gap-2 shrink-0">
              {explorerUrl && (
                <a
                  href={explorerUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-lg bg-ink-800 px-2.5 py-1 text-xs font-medium text-mist hover:text-white transition-colors"
                >
                  <ExternalLinkIcon />
                  Explorer
                </a>
              )}
              <button
                type="button"
                onClick={() => dismiss(t.id)}
                className="text-mist/60 hover:text-white p-0.5"
                aria-label="Dismiss"
              >
                ×
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function MotionAwareApp() {
  const reduceMotion = usePrefersReducedMotion();

  return (
    <MotionConfig reducedMotion={reduceMotion ? "always" : "never"}>
      <MotionPreferenceEffect />
      <NetworkMismatchModal />
      <SessionTimeoutProvider>
        <AppContent />
      </SessionTimeoutProvider>
      <ToastLayer />
    </MotionConfig>
  );
}

export default function App() {
  return (
    <KeysProvider>
      <ProtocolLogProvider>
        <ToastProvider>
          <MotionAwareApp />
        </ToastProvider>
      </ProtocolLogProvider>
    </KeysProvider>
  );
}
