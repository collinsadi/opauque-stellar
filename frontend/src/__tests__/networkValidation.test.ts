import { describe, it, expect, vi, beforeEach } from "vitest";
import { NetworkValidationService } from "../services/networkValidation";
import { useSecurityStore } from "../store/securityStore";

vi.mock("@stellar/freighter-api", () => ({
  isAllowed: vi.fn().mockResolvedValue({ isAllowed: true }),
  setAllowed: vi.fn().mockResolvedValue({ isAllowed: true }),
  getNetworkDetails: vi.fn()
}));

import { getNetworkDetails } from "@stellar/freighter-api";

const resolveNetwork = (network: string) =>
  vi.mocked(getNetworkDetails).mockResolvedValue({
    network,
  } as Awaited<ReturnType<typeof getNetworkDetails>>);

describe("NetworkValidationService", () => {
  beforeEach(() => {
    useSecurityStore.setState({ expectedNetwork: "testnet" });
    vi.clearAllMocks();
  });

  it("should validate when network matches exactly", async () => {
    resolveNetwork("testnet");
    const result = await NetworkValidationService.validateWalletContext();
    expect(result.valid).toBe(true);
    expect(result.expected).toBe("testnet");
    expect(result.actual).toBe("testnet");
  });

  it("should validate local networks flexibly", async () => {
    useSecurityStore.setState({ expectedNetwork: "local" });
    resolveNetwork("Standalone Network ; February 2017");
    const result = await NetworkValidationService.validateWalletContext();
    expect(result.valid).toBe(true);
  });

  it("should return invalid on mismatch", async () => {
    useSecurityStore.setState({ expectedNetwork: "mainnet" });
    resolveNetwork("testnet");
    const result = await NetworkValidationService.validateWalletContext();
    expect(result.valid).toBe(false);
    expect(result.expected).toBe("mainnet");
  });

  it("requireValidNetwork should throw on mismatch", async () => {
    useSecurityStore.setState({ expectedNetwork: "mainnet" });
    resolveNetwork("testnet");
    await expect(NetworkValidationService.requireValidNetwork()).rejects.toThrow(/Network mismatch detected/);
  });

  it("should recognize Freighter's PUBLIC as mainnet", async () => {
    useSecurityStore.setState({ expectedNetwork: "mainnet" });
    resolveNetwork("PUBLIC");
    const result = await NetworkValidationService.validateWalletContext();
    expect(result.valid).toBe(true);
  });

  it("should recognize Freighter's TESTNET as testnet", async () => {
    useSecurityStore.setState({ expectedNetwork: "testnet" });
    resolveNetwork("TESTNET");
    const result = await NetworkValidationService.validateWalletContext();
    expect(result.valid).toBe(true);
  });

  it("should reject PUBLIC when expecting testnet", async () => {
    useSecurityStore.setState({ expectedNetwork: "testnet" });
    resolveNetwork("PUBLIC");
    const result = await NetworkValidationService.validateWalletContext();
    expect(result.valid).toBe(false);
  });
});
