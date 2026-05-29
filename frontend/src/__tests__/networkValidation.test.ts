import { describe, it, expect, vi, beforeEach } from "vitest";
import { NetworkValidationService } from "../services/networkValidation";
import { useSecurityStore } from "../store/securityStore";

vi.mock("@stellar/freighter-api", () => ({
  isAllowed: vi.fn().mockResolvedValue(true),
  setAllowed: vi.fn().mockResolvedValue(true),
  getNetworkDetails: vi.fn()
}));

import { getNetworkDetails } from "@stellar/freighter-api";

describe("NetworkValidationService", () => {
  beforeEach(() => {
    useSecurityStore.setState({ expectedNetwork: "testnet" });
    vi.clearAllMocks();
  });

  it("should validate when network matches exactly", async () => {
    (getNetworkDetails as any).mockResolvedValue({ network: "testnet" });
    const result = await NetworkValidationService.validateWalletContext();
    expect(result.valid).toBe(true);
    expect(result.expected).toBe("testnet");
    expect(result.actual).toBe("testnet");
  });

  it("should validate local networks flexibly", async () => {
    useSecurityStore.setState({ expectedNetwork: "local" });
    (getNetworkDetails as any).mockResolvedValue({ network: "Standalone Network ; February 2017" });
    const result = await NetworkValidationService.validateWalletContext();
    expect(result.valid).toBe(true);
  });

  it("should return invalid on mismatch", async () => {
    useSecurityStore.setState({ expectedNetwork: "mainnet" });
    (getNetworkDetails as any).mockResolvedValue({ network: "testnet" });
    const result = await NetworkValidationService.validateWalletContext();
    expect(result.valid).toBe(false);
    expect(result.expected).toBe("mainnet");
    expect(result.actual).toBe("testnet");
  });

  it("requireValidNetwork should throw on mismatch", async () => {
    useSecurityStore.setState({ expectedNetwork: "mainnet" });
    (getNetworkDetails as any).mockResolvedValue({ network: "testnet" });
    await expect(NetworkValidationService.requireValidNetwork()).rejects.toThrow(/Network mismatch detected/);
  });
});
