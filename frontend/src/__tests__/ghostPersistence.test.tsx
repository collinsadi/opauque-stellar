/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { GhostPersistenceWarning } from "../components/GhostPersistenceWarning";
import { useGhostAddressStore } from "../store/ghostAddressStore";

afterEach(() => {
  cleanup();
  useGhostAddressStore.setState({ entries: [], persistenceFailed: false });
});

describe("GhostPersistenceWarning", () => {
  it("renders nothing when persistence has not failed", () => {
    render(<GhostPersistenceWarning />);
    expect(screen.queryByText("Storage unavailable")).toBeNull();
  });

  it("renders warning when persistence has failed", () => {
    useGhostAddressStore.setState({ persistenceFailed: true });
    render(<GhostPersistenceWarning />);
    expect(screen.getByText("Storage unavailable")).toBeDefined();
    expect(screen.getByText(/could not be saved/)).toBeDefined();
  });

  it("prompts user to export a backup", () => {
    useGhostAddressStore.setState({ persistenceFailed: true });
    render(<GhostPersistenceWarning />);
    expect(screen.getByText(/export a backup/)).toBeDefined();
  });
});

describe("ghostAddressStore persistence failure tracking", () => {
  let setItemSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    setItemSpy?.mockRestore();
  });

  it("sets persistenceFailed to true when persistEntries fails", async () => {
    setItemSpy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError", "QuotaExceededError");
    });

    useGhostAddressStore.setState({ persistenceFailed: false });
    useGhostAddressStore.getState().add({
      cluster: "testnet",
      stealthAddress: "GABC123",
      ephemeralPrivKeyHex: "deadbeef",
    });

    await vi.waitFor(() => {
      expect(useGhostAddressStore.getState().persistenceFailed).toBe(true);
    });
  });

  it("tracks persistence failure on remove", async () => {
    setItemSpy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError", "QuotaExceededError");
    });

    useGhostAddressStore.setState({
      entries: [
        {
          cluster: "testnet",
          stealthAddress: "GABC123",
          ephemeralPrivKeyHex: "deadbeef",
          createdAt: Date.now(),
        },
      ],
      persistenceFailed: false,
    });

    useGhostAddressStore.getState().remove("GABC123", "testnet");

    await vi.waitFor(() => {
      expect(useGhostAddressStore.getState().persistenceFailed).toBe(true);
    });
  });
});
