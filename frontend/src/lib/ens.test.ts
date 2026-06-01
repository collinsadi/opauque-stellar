import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { isDomainName, resolveDomain } from "./ens";

// Mock fetch
global.fetch = vi.fn();

describe("Stellar Federation Resolver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("isDomainName", () => {
    it("should identify valid federation addresses", () => {
      expect(isDomainName("alice*example.com")).toBe(true);
      expect(isDomainName("bob*stellar.org")).toBe(true);
      expect(isDomainName("user123*domain.test")).toBe(true);
    });

    it("should handle case-insensitive matching", () => {
      expect(isDomainName("Alice*Example.COM")).toBe(true);
      expect(isDomainName("BOB*STELLAR.ORG")).toBe(true);
    });

    it("should handle whitespace", () => {
      expect(isDomainName("  alice*example.com  ")).toBe(true);
    });

    it("should reject non-federation addresses", () => {
      expect(isDomainName("0x1234567890abcdef")).toBe(false);
      expect(isDomainName("example.sol")).toBe(false);
      expect(isDomainName("example.com")).toBe(false);
      expect(isDomainName("alice@example.com")).toBe(false);
      expect(isDomainName("alice")).toBe(false);
    });

    it("should reject multiple asterisks", () => {
      expect(isDomainName("alice*bob*example.com")).toBe(false);
    });

    it("should reject empty strings", () => {
      expect(isDomainName("")).toBe(false);
      expect(isDomainName("   ")).toBe(false);
    });
  });

  describe("resolveDomain - Non-federation addresses", () => {
    it("should return null for non-federation addresses", async () => {
      const result = await resolveDomain("0x1234567890abcdef");
      expect(result).toBeNull();
    });

    it("should return null for direct addresses", async () => {
      const result = await resolveDomain("GBBD47UZQ2BNPGMFIPAZT5FJNAFZMPA5SPCVBNBVQMZLHAVLDOG4SEGBB");
      expect(result).toBeNull();
    });

    it("should not call fetch for non-federation addresses", async () => {
      await resolveDomain("example.com");
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  describe("resolveDomain - Successful resolution", () => {
    const federationAddress = "alice*example.com";
    const expectedAccountId =
      "GBBD47UZQ2BNPGMFIPAZT5FJNAFZMPA5SPCVBNBVQMZLHAVLDOG4SEGBB";

    it("should resolve a valid federation address", async () => {
      const mockFetch = fetch as any;

      // Mock stellar.toml fetch
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () =>
          `
# Stellar TOML
FEDERATION_SERVER="https://federation.example.com"
          `,
      });

      // Mock federation server response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          account_id: expectedAccountId,
          memo_type: "id",
          memo: "123",
        }),
      });

      const result = await resolveDomain(federationAddress);
      expect(result).toBe(expectedAccountId);
    });

    it("should handle case-insensitive federation addresses", async () => {
      const mockFetch = fetch as any;

      // Mock stellar.toml fetch
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () => `FEDERATION_SERVER="https://federation.example.com"`,
      });

      // Mock federation server response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          account_id: expectedAccountId,
        }),
      });

      const result = await resolveDomain("ALICE*EXAMPLE.COM");
      expect(result).toBe(expectedAccountId);
    });

    it("should handle whitespace in address", async () => {
      const mockFetch = fetch as any;

      // Mock stellar.toml fetch
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () => `FEDERATION_SERVER="https://federation.example.com"`,
      });

      // Mock federation server response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          account_id: expectedAccountId,
        }),
      });

      const result = await resolveDomain("  alice*example.com  ");
      expect(result).toBe(expectedAccountId);
    });

    it("should parse stellar.toml with quoted values", async () => {
      const mockFetch = fetch as any;

      // Mock stellar.toml fetch with quoted FEDERATION_SERVER
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () =>
          `
# Stellar TOML
FEDERATION_SERVER = "https://federation.example.com"
        `,
      });

      // Mock federation server response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          account_id: expectedAccountId,
        }),
      });

      const result = await resolveDomain(federationAddress);
      expect(result).toBe(expectedAccountId);
    });

    it("should pass correct parameters to federation server", async () => {
      const mockFetch = fetch as any;

      // Mock stellar.toml fetch
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () =>
          `FEDERATION_SERVER="https://federation.example.com"`,
      });

      // Mock federation server response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          account_id: expectedAccountId,
        }),
      });

      await resolveDomain(federationAddress);

      // Check that federation server was called with correct parameters
      const federationCall = (mockFetch as any).mock.calls[1];
      expect(federationCall[0]).toContain("federation.example.com");
      expect(federationCall[0]).toContain("type=name");
      expect(federationCall[0]).toContain("q=alice*example.com");
    });
  });

  describe("resolveDomain - Error handling", () => {
    it("should throw error if stellar.toml fetch fails", async () => {
      const mockFetch = fetch as any;
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      await expect(resolveDomain("alice*example.com")).rejects.toThrow(
        /Cannot resolve domain/
      );
    });

    it("should throw error if stellar.toml returns 404", async () => {
      const mockFetch = fetch as any;
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      await expect(resolveDomain("alice*example.com")).rejects.toThrow(
        /Cannot resolve domain/
      );
    });

    it("should throw error if stellar.toml is missing FEDERATION_SERVER", async () => {
      const mockFetch = fetch as any;
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () => `
# Stellar TOML
NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
        `,
      });

      await expect(resolveDomain("alice*example.com")).rejects.toThrow(
        /does not support Stellar federation/
      );
    });

    it("should throw error if federation server returns 404", async () => {
      const mockFetch = fetch as any;

      // Mock stellar.toml fetch
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () =>
          `FEDERATION_SERVER="https://federation.example.com"`,
      });

      // Mock federation server 404 response
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      await expect(resolveDomain("alice*example.com")).rejects.toThrow(
        /Federation record not found/
      );
    });

    it("should throw error if federation server returns error status", async () => {
      const mockFetch = fetch as any;

      // Mock stellar.toml fetch
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () =>
          `FEDERATION_SERVER="https://federation.example.com"`,
      });

      // Mock federation server error response
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
      });

      await expect(resolveDomain("alice*example.com")).rejects.toThrow(
        /Federation server error/
      );
    });

    it("should throw error if federation server returns no account_id", async () => {
      const mockFetch = fetch as any;

      // Mock stellar.toml fetch
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () =>
          `FEDERATION_SERVER="https://federation.example.com"`,
      });

      // Mock federation server response without account_id
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          memo_type: "id",
          memo: "123",
        }),
      });

      await expect(resolveDomain("alice*example.com")).rejects.toThrow(
        /No account_id returned/
      );
    });

    it("should throw error if federation server connection fails", async () => {
      const mockFetch = fetch as any;

      // Mock stellar.toml fetch
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () =>
          `FEDERATION_SERVER="https://federation.example.com"`,
      });

      // Mock federation server connection failure
      mockFetch.mockRejectedValueOnce(new Error("Connection timeout"));

      await expect(resolveDomain("alice*example.com")).rejects.toThrow(
        /Federation lookup failed/
      );
    });

    it("should throw clear error for invalid federation address", async () => {
      // Not testing actual resolution since isDomainName rejects it
      // But ensure error message is clear if format is somehow invalid
      await expect(resolveDomain("*domain.com")).rejects.toThrow(
        /Invalid federation address format/
      );
    });
  });

  describe("resolveDomain - TOML parsing", () => {
    it("should parse stellar.toml with comments", async () => {
      const mockFetch = fetch as any;

      // Mock stellar.toml fetch with comments
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () => `
# This is a comment
FEDERATION_SERVER="https://federation.example.com"
# Another comment
NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
        `,
      });

      // Mock federation server response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          account_id:
            "GBBD47UZQ2BNPGMFIPAZT5FJNAFZMPA5SPCVBNBVQMZLHAVLDOG4SEGBB",
        }),
      });

      const result = await resolveDomain("alice*example.com");
      expect(result).toBe(
        "GBBD47UZQ2BNPGMFIPAZT5FJNAFZMPA5SPCVBNBVQMZLHAVLDOG4SEGBB"
      );
    });

    it("should parse stellar.toml with single quotes", async () => {
      const mockFetch = fetch as any;

      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () => `FEDERATION_SERVER = 'https://federation.example.com'`,
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          account_id:
            "GBBD47UZQ2BNPGMFIPAZT5FJNAFZMPA5SPCVBNBVQMZLHAVLDOG4SEGBB",
        }),
      });

      const result = await resolveDomain("alice*example.com");
      expect(result).toBe(
        "GBBD47UZQ2BNPGMFIPAZT5FJNAFZMPA5SPCVBNBVQMZLHAVLDOG4SEGBB"
      );
    });

    it("should handle empty lines in stellar.toml", async () => {
      const mockFetch = fetch as any;

      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () => `

FEDERATION_SERVER="https://federation.example.com"

        `,
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          account_id:
            "GBBD47UZQ2BNPGMFIPAZT5FJNAFZMPA5SPCVBNBVQMZLHAVLDOG4SEGBB",
        }),
      });

      const result = await resolveDomain("alice*example.com");
      expect(result).toBe(
        "GBBD47UZQ2BNPGMFIPAZT5FJNAFZMPA5SPCVBNBVQMZLHAVLDOG4SEGBB"
      );
    });
  });
});
