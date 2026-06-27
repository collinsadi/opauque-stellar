import { useState, useRef, useEffect, type ReactNode } from "react";
import { Link, useNavigate, useLocation } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { TestnetBanner } from "./TestnetBanner";
import { isTabNavVisible } from "../lib/tabAccess";

export type Tab =
  | "dashboard"
  | "send"
  | "receive"
  | "balance"
  | "history"
  | "profile"
  | "reputation"
  // V2 tabs
  | "schemas"
  | "attest"
  | "my-traits"
  | "manage";

type LayoutProps = {
  tab: Tab;
  onTabChange: (t: Tab) => void;
  isConnected: boolean;
  address: string | undefined;
  isConnecting: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  children: ReactNode;
  protocolLog: ReactNode;
};

const navItems: { id: Tab; label: string }[] = [];

function DesktopNav({
  tab,
  onTabChange,
  isConnected,
  address,
  isConnecting,
  onConnect,
  onDisconnect,
}: Pick<
  LayoutProps,
  "tab" | "onTabChange" | "isConnected" | "address" | "isConnecting" | "onConnect" | "onDisconnect"
>) {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <header className="shrink-0 border-b border-ink-700/60 bg-ink-950/80 backdrop-blur-lg">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-5 sm:px-8">
        <div className="flex items-center gap-6">
          {location.pathname === "/app" ? (
            <Link
              to="/app"
              onClick={() => onTabChange("dashboard")}
              className="font-display text-base font-bold tracking-tight text-white transition-colors hover:text-white"
            >
              Opaque<span className="text-white">.</span>
            </Link>
          ) : (
            <button
              type="button"
              onClick={() => navigate("/app", { state: { tab: "dashboard" } })}
              className="font-display text-base font-bold tracking-tight text-white transition-colors hover:text-white"
            >
              Opaque<span className="text-white">.</span>
            </button>
          )}
          {navItems.length > 0 && (
            <nav className="flex items-center gap-1">
              {navItems.map(({ id, label }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => onTabChange(id)}
                  className={`rounded-lg px-3 py-1.5 text-sm transition-colors ${
                    tab === id
                      ? "bg-black/25 font-medium text-white"
                      : "text-mist/80 hover:text-white"
                  }`}
                >
                  {label}
                </button>
              ))}
            </nav>
          )}
        </div>

        <div className="relative flex items-center gap-3" ref={dropdownRef}>
          {!isConnected && (
            <button
              type="button"
              onClick={onConnect}
              disabled={isConnecting}
              data-tour="connect"
              className="rounded-lg bg-sol-gradient border border-transparent px-4 py-1.5 text-sm font-semibold text-white transition-all hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-white focus-visible:outline-offset-2"
            >
              {isConnecting ? "Connecting…" : "Connect"}
            </button>
          )}
          {isConnected && address && (
            <>
              <div
                role="button"
                tabIndex={0}
                onClick={() => setDropdownOpen((o) => !o)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setDropdownOpen((o) => !o);
                  }
                }}
                className="flex items-center gap-2 rounded-xl border border-white/20 bg-ink-900/60 px-2.5 py-1.5 transition-colors hover:border-white/40 cursor-pointer"
                data-tour="meta"
              >
                <img
                  src={`https://robohash.org/${address}`}
                  alt=""
                  className="h-7 w-7 rounded-full bg-ink-800"
                />
              </div>
              {dropdownOpen && (
                <div className="absolute right-0 top-full mt-1.5 w-52 rounded-xl border border-ink-700 bg-ink-900/95 py-1.5 shadow-2xl backdrop-blur-lg z-30">
                  {([
                    { id: "balance" as Tab, label: "Private balance" },
                    { id: "history" as Tab, label: "Transaction history" },
                    ...(isTabNavVisible("manage") ? [{ id: "manage" as Tab, label: "Manage" }] : []),
                    { id: "profile" as Tab, label: "Profile" },
                  ]).map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => { onTabChange(item.id); setDropdownOpen(false); }}
                      className="w-full px-4 py-2 text-left text-sm text-mist transition-colors hover:bg-black/15 hover:text-white"
                    >
                      {item.label}
                    </button>
                  ))}
                  <div className="my-1 border-t border-ink-700/60" />
                  <button
                    type="button"
                    onClick={() => { onDisconnect(); setDropdownOpen(false); }}
                    className="w-full px-4 py-2 text-left text-sm text-mist transition-colors hover:bg-black/15 hover:text-white"
                  >
                    Disconnect
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </header>
  );
}

const mobileTabs: { id: Tab; label: string; icon: string }[] = [
  { id: "dashboard" as Tab, label: "Home", icon: "⌂" },
  { id: "reputation" as Tab, label: "My Traits", icon: "✦" },
  { id: "manage" as Tab, label: "Manage", icon: "◈" },
  { id: "profile" as Tab, label: "Profile", icon: "⚙" },
].filter((item) => isTabNavVisible(item.id));

function MobileNav({ tab, onTabChange }: Pick<LayoutProps, "tab" | "onTabChange">) {
  return (
    <nav
      aria-label="Primary"
      className="md:hidden fixed bottom-0 left-0 right-0 z-20 border-t border-ink-700/60 bg-ink-950/80 backdrop-blur-lg pb-[env(safe-area-inset-bottom)]"
    >
      <div className="flex items-center justify-around py-2 px-2">
        {mobileTabs.map(({ id, label, icon }) => {
          const active = tab === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => onTabChange(id)}
              aria-current={active ? "page" : undefined}
              aria-label={`Go to ${label}`}
              className={`flex flex-col items-center gap-0.5 rounded-lg px-4 py-2 min-w-[72px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-white ${
                active ? "text-white" : "text-mist/60 hover:text-white"
              }`}
            >
              <span className="text-lg" aria-hidden>{icon}</span>
              <span className="text-[11px] font-medium">{label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

const pageVariants = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -4 },
};

export function Layout({
  tab,
  onTabChange,
  isConnected,
  address,
  isConnecting,
  onConnect,
  onDisconnect,
  children,
  protocolLog,
}: LayoutProps) {
  return (
    <div className="min-h-dvh flex flex-col bg-ink-950 bg-grid-fade bg-size-grid">
      {/* ── Fixed header ── */}
      <div className="hidden md:flex flex-col fixed top-0 left-0 right-0 z-20">
        <TestnetBanner isConnected={isConnected} />
        <DesktopNav
          tab={tab}
          onTabChange={onTabChange}
          isConnected={isConnected}
          address={address}
          isConnecting={isConnecting}
          onConnect={onConnect}
          onDisconnect={onDisconnect}
        />
      </div>
      <div className="md:hidden">
        <TestnetBanner isConnected={isConnected} />
      </div>

      {/* ── Content ── */}
      <div className="flex-1 min-h-0 overflow-y-auto pt-8 md:pt-24 pb-24 md:pb-16">
        <main
          id="main-content"
          tabIndex={-1}
          className="mx-auto flex w-full max-w-3xl flex-1 min-h-0 flex-col px-5 sm:px-8 pt-6 pb-8 focus:outline-none"
        >
          <AnimatePresence mode="wait">
            <motion.div
              key={tab}
              variants={pageVariants}
              initial="initial"
              animate="animate"
              exit="exit"
              transition={{ duration: 0.15, ease: "easeOut" }}
            >
              {children}
            </motion.div>
          </AnimatePresence>
        </main>
      </div>

      {/* ── Mobile nav ── */}
      <MobileNav tab={tab} onTabChange={onTabChange} />

      {protocolLog}
    </div>
  );
}
