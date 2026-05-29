import { isAllowed, getNetworkDetails, setAllowed } from "@stellar/freighter-api";
import { useSecurityStore } from "../store/securityStore";

export class NetworkValidationService {
  /**
   * Returns the current Freighter network details.
   */
  static async getWalletNetwork(): Promise<string> {
    if (!(await isAllowed())) {
      await setAllowed();
    }
    try {
      const details = await getNetworkDetails();
      return details.network.toLowerCase();
    } catch (e) {
      console.error("Error getting network details from Freighter:", e);
      return "unknown";
    }
  }

  /**
   * Verifies if the wallet network matches the application's configured expected network.
   */
  static async validateWalletContext(): Promise<{ valid: boolean; expected: string; actual: string }> {
    const expected = useSecurityStore.getState().expectedNetwork;
    const actual = await this.getWalletNetwork();
    
    // Some normalization for local networks
    const isLocalMatch = expected === "local" && (actual.includes("local") || actual.includes("standalone"));
    
    // Testnet can sometimes be TESTNET or testnet, same for others.
    const isExactMatch = actual.includes(expected);

    return {
      valid: isExactMatch || isLocalMatch,
      expected,
      actual
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
