import { isAllowed, getNetworkDetails } from "@stellar/freighter-api";
import { useSecurityStore } from "../store/securityStore";
import { networkConnectivityService } from "./networkConnectivity";

export class NetworkValidationService {
  /**
   * Returns the current Freighter network (lowercased), or "unknown" if the wallet
   * isn't connected/authorized yet.
   *
   * Passive read only, it must NOT call setAllowed()/requestAccess(). This runs on
   * background checks (e.g. the network-mismatch watcher), and prompting for access on
   * a timer made Freighter pop up repeatedly on the onboarding screen. Access is
   * requested explicitly via the connect button (see StellarWalletProviders).
   */
  static async getWalletNetwork(): Promise<string> {
    try {
      const allowed = await isAllowed();
      if (!allowed.isAllowed) return "unknown";
      const details = await getNetworkDetails();
      if (details.error || !details.network) return "unknown";
      return details.network.toLowerCase();
    } catch (e) {
      console.error("Error getting network details from Freighter:", e);
      return "unknown";
    }
  }

  /**
   * Canonical mapping from Freighter's reported network identifiers to the
   * application's internal names. Freighter may report "PUBLIC" for mainnet
   * and "TESTNET" for testnet, while the app uses "mainnet"/"testnet".
   */
  private static readonly NETWORK_ALIASES: Record<string, string> = {
    public: "mainnet",
    "public network": "mainnet",
    "test net": "testnet",
    futurenet: "futurenet",
    standalone: "local",
    "standalone network": "local",
  };

  private static normalizeNetworkName(raw: string): string {
    const lower = raw.toLowerCase().trim();
    // Direct match
    if (NetworkValidationService.NETWORK_ALIASES[lower]) {
      return NetworkValidationService.NETWORK_ALIASES[lower];
    }
    // Freighter sometimes returns long passphrase-style names; check for keywords
    if (lower.includes("public")) return "mainnet";
    if (lower.includes("testnet") || lower.includes("test net")) return "testnet";
    if (lower.includes("futurenet") || lower.includes("future")) return "futurenet";
    if (lower.includes("standalone") || lower.includes("local")) return "local";
    return lower;
  }

  /**
   * Verifies if the wallet network matches the application's configured expected network.
   */
  static async validateWalletContext(): Promise<{ valid: boolean; expected: string; actual: string }> {
    const expected = useSecurityStore.getState().expectedNetwork;
    const rawActual = await this.getWalletNetwork();
    const actual = this.normalizeNetworkName(rawActual);

    return {
      valid: actual === expected,
      expected,
      actual: rawActual,
    };
  }

  /**
   * Throws an error if the network mismatch occurs. Used before signing.
   */
  static async requireValidNetwork() {
    const validation = await this.validateWalletContext();
    if (!validation.valid) {
      throw new Error(`Network mismatch detected. Expected: ${validation.expected}, Wallet: ${validation.actual}`);
    }
  }
}
