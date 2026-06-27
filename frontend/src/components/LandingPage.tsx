import { Footer } from "./Footer";
import { Link } from "react-router-dom";
import {
  PRIVACY_NOT_HIDDEN,
  PRIVACY_PROVIDED,
  THREAT_MODEL_ROUTE,
} from "../lib/privacyThreatModel";

type LandingPageProps = {
  onEnterVault: () => void;
};

const FEATURES = [
  {
    icon: "↕",
    accent: "green" as const,
    title: "Stealth payments",
    body: "Senders derive a fresh one-time receive surface from your stealth meta-address. Incoming XLM lands at outputs only you can spend.",
  },
  {
    icon: "⌘",
    accent: "green" as const,
    title: "On-chain registry",
    body: "Link your Stellar account to a meta-address on Soroban so payers can resolve you without passing a long key every time.",
  },
  {
    icon: "◉",
    accent: "green" as const,
    title: "Announcement stream",
    body: "Contract events with view tags let your wallet discover which announcements are yours—without revealing who is scanning.",
  },
  {
    icon: "✦",
    accent: "purple" as const,
    title: "Proof-backed reputation",
    body: "Optional PSR layer: Groth16 proofs + Merkle roots + nullifiers let apps verify traits without tying them to your public wallet.",
  },
  {
    icon: "⬡",
    accent: "green" as const,
    title: "Browser-native crypto",
    body: "Rust → WASM for secp256k1 scanning, snarkjs + Circom for ZK proofs—runs entirely on-device with no server round-trips.",
  },
  {
    icon: "⛓",
    accent: "green" as const,
    title: "Open contracts",
    body: "Registry, announcer, and verifier contracts on Soroban. No proprietary backend—integrators use the same on-chain interfaces.",
  },
] as const;

const STEPS = [
  {
    n: "01",
    title: "Initialize",
    body: "Sign a message with Freighter to derive stealth keys locally. Nothing leaves your device.",
  },
  {
    n: "02",
    title: "Register",
    body: "One-time transaction: register your meta-address on the stealth registry contract.",
  },
  {
    n: "03",
    title: "Receive",
    body: "Senders use your meta-address; announcements land on-chain. You scan locally to find and manage balances.",
  },
  {
    n: "04",
    title: "Prove (optional)",
    body: "Generate a ZK proof scoped to an action—verify on-chain without revealing your wallet.",
  },
] as const;

export function LandingPage({ onEnterVault }: LandingPageProps) {
  return (
    <div className="min-h-dvh flex flex-col bg-ink-950 bg-grid-fade bg-size-grid text-white overflow-x-hidden">
      <section className="relative flex flex-col items-center text-center px-5 sm:px-8 pt-20 sm:pt-28 md:pt-36 pb-20 md:pb-28">
        <div
          className="pointer-events-none absolute inset-0"
          aria-hidden
        />

        <span className="relative inline-flex items-center gap-2 rounded-full border border-white/30 bg-black/15 px-3.5 py-1 text-xs font-medium text-white mb-6">
          <span className="h-1.5 w-1.5 rounded-full bg-glow" aria-hidden />
          Stellar · Stealth addresses
        </span>

        <h1 className="relative font-display text-5xl sm:text-6xl md:text-7xl font-extrabold tracking-tight leading-[1.05]">
          Privacy protocol
          <br />
          <span className="text-white">on Stellar</span>
          <span className="text-glow">.</span>
        </h1>

        <p className="relative mt-6 max-w-2xl text-lg text-mist leading-relaxed">
          <strong className="text-white">Opaque</strong> is a Stellar-native stealth layer: unlinkable receives,
          optional <strong className="text-white">ZK-backed reputation</strong>, and
          contracts you can verify on-chain—without exposing your everyday wallet.
        </p>

        <div className="relative mt-8 flex flex-col sm:flex-row items-center gap-4">
          <button
            type="button"
            onClick={onEnterVault}
            className="group inline-flex items-center gap-2.5 rounded-xl bg-sol-gradient px-7 py-3.5 text-sm font-semibold text-white border border-white transition-all hover:opacity-90 hover:scale-[1.02] active:scale-[0.98]"
          >
            Open wallet
            <span className="transition-transform group-hover:translate-x-0.5" aria-hidden>
              →
            </span>
          </button>
        </div>
      </section>

      <section className="mx-auto w-full max-w-6xl px-5 sm:px-8 pb-20 md:pb-28">
        <div className="mb-10 text-center">
          <p className="text-xs font-semibold uppercase tracking-widest text-white">
            Core primitives
          </p>
          <h2 className="mt-2 font-display text-3xl font-bold text-white sm:text-4xl">
            What the protocol provides
          </h2>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <div
              key={f.title}
              className="group rounded-2xl border border-ink-600 bg-ink-900/25 p-6 transition-all hover:border-white/30 hover:border-white"
            >
              <span
                className={`mb-4 flex h-10 w-10 items-center justify-center rounded-xl text-lg ${
                  f.accent === "purple"
                    ? "bg-black/30 text-white"
                    : "bg-glow-muted/30 text-glow"
                }`}
                aria-hidden
              >
                {f.icon}
              </span>
              <h3 className="font-display text-sm font-bold text-white">{f.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-mist">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto w-full max-w-4xl px-5 sm:px-8 pb-20 md:pb-28">
        <div className="mb-10 text-center">
          <p className="text-xs font-semibold uppercase tracking-widest text-white">
            Flow
          </p>
          <h2 className="mt-2 font-display text-3xl font-bold text-white sm:text-4xl">
            How it works
          </h2>
        </div>

        <div className="relative grid gap-6 sm:grid-cols-2">
          {STEPS.map((s) => (
            <div
              key={s.n}
              className="rounded-2xl border border-ink-700 bg-ink-900/30 p-6 transition-all hover:border-white/20"
            >
              <span className="mb-3 inline-flex h-8 w-8 items-center justify-center rounded-lg bg-black/30 font-mono text-xs font-bold text-white">
                {s.n}
              </span>
              <h3 className="font-display text-base font-bold text-white">{s.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-mist">{s.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto w-full max-w-4xl px-5 sm:px-8 pb-20 md:pb-28">
        <div className="rounded-3xl border border-ink-700 bg-ink-900/20 p-6 md:p-8">
          <h2 className="font-display text-xl font-bold text-white md:text-2xl">
            Privacy &amp; trade-offs
          </h2>
          <div className="mt-5 grid gap-4 md:grid-cols-2">
            <div className="rounded-2xl border border-white/20 bg-ink-950/40 p-5">
              <p className="text-sm font-semibold text-glow font-display">What's private</p>
              <ul className="mt-3 space-y-2 text-sm text-mist leading-relaxed">
                {PRIVACY_PROVIDED.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
            <div className="rounded-2xl border border-white/20 bg-ink-950/40 p-5">
              <p className="text-sm font-semibold text-flare font-display">What's not magic</p>
              <ul className="mt-3 space-y-2 text-sm text-mist leading-relaxed">
                {PRIVACY_NOT_HIDDEN.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          </div>
          <p className="mt-5 text-sm text-mist">
            <Link
              to={THREAT_MODEL_ROUTE}
              className="font-medium text-white underline hover:text-white"
            >
              Read the full privacy threat model
            </Link>{" "}
            for adversaries, mitigations, and implementation mapping.
          </p>
        </div>
      </section>

      <div className="mt-auto shrink-0 w-full pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <Footer />
      </div>
    </div>
  );
}
