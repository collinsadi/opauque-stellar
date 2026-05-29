import { Link } from "react-router-dom";

export function Footer() {
  return (
    <footer className="px-5 py-4 text-center text-xs text-mist/70 sm:px-8">
      <nav className="mb-2 flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
        <Link
          to="/privacy"
          className="hover:text-sol-purple transition-colors"
        >
          Privacy
        </Link>
        <Link
          to="/terms"
          className="hover:text-sol-purple transition-colors"
        >
          Terms
        </Link>
        <Link
          to="/disclaimer"
          className="hover:text-sol-purple transition-colors"
        >
          Disclaimer
        </Link>
        <Link
          to="/abuse-policy"
          className="hover:text-sol-purple transition-colors"
        >
          Abuse policy
        </Link>
      </nav>
      <p className="font-mono text-mist/60">
        © 2026 Opaque Protocol. Stellar stealth and reputation stack.
      </p>
    </footer>
  );
}
