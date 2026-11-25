/**
 * @vitest-environment jsdom
 *
 * SendView finishes validation before it enters the busy state (#922): a bad amount
 * or memo must never trigger a registry lookup, the stepper, or the "Sending…" state.
 */
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// Fixed, valid G-addresses (Keypair.random() trips noble-curves under jsdom).
const WALLET = "GA5XIGA5C7QTPTWXQHY6MCJRMTRZDOSHR6EFIBNDQTCQHG262N4GGKTM";
const RECIPIENT_G = "GCMPINZMMQVQ7MWIJLB34F5JRAHLQQTWCP6XB5HEZR353PPPWRUWHLPU";

vi.mock("../context/KeysContext", () => ({ useKeys: () => ({ isSetup: true }) }));
vi.mock("../hooks/useWallet", () => ({
  useWallet: () => ({
    publicKey: WALLET,
    connected: true,
    connecting: false,
    signTransaction: vi.fn(),
    connect: vi.fn(),
  }),
}));
vi.mock("../context/ProtocolLogContext", () => ({ useProtocolLog: () => ({ push: vi.fn() }) }));
vi.mock("../lib/chain", () => ({
  getNetwork: () => "testnet",
  getNetworkPassphrase: () => "Test SDF Network ; September 2015",
}));
vi.mock("../contracts/contract-config", () => ({ getConfigForCluster: () => ({}) }));
vi.mock("../contracts/deployedAddresses", () => ({
  deployedAddresses: { stealthAnnouncer: "C".repeat(56) },
}));
vi.mock("../lib/maxSendable", () => ({
  getMaxSendableQuote: vi.fn(async () => ({
    balanceStroops: 1_000_000_000n,
    minimumBalanceStroops: 10_000_000n,
    transferFeeStroops: 100n,
    announcementFeeStroops: 5_000n,
    maxSendableStroops: 989_994_900n,
  })),
}));
vi.mock("../lib/stellar", async () => ({
  getHorizonServer: () => ({ loadAccount: vi.fn() }),
  getSorobanServer: () => ({ prepareTransaction: vi.fn() }),
  buildNativeTransferOperation: vi.fn(),
  parseXlmToStroops: (await import("../lib/decimalParser")).parseXlmToStroops,
}));
vi.mock("../lib/registry", () => ({ resolveMetaAddress: vi.fn() }));
vi.mock("../services/networkValidation", () => ({
  NetworkValidationService: { requireValidNetwork: vi.fn() },
}));
vi.mock("./QrScanner", () => ({ QrScanner: () => null }));

import { SendView } from "../components/SendView";
import { resolveMetaAddress } from "../lib/registry";

const resolveMock = vi.mocked(resolveMetaAddress);

function renderView() {
  return render(
    <MemoryRouter>
      <SendView />
    </MemoryRouter>,
  );
}

async function fill({ recipient, amount, memo }: { recipient: string; amount: string; memo?: string }) {
  renderView();
  fireEvent.change(screen.getByPlaceholderText(/payment link/), { target: { value: recipient } });
  fireEvent.change(screen.getByPlaceholderText("0.0"), { target: { value: amount } });
  if (memo !== undefined) fireEvent.change(screen.getByPlaceholderText("Optional"), { target: { value: memo } });
  // Wait for the max-sendable quote so the button reflects the real balance state.
  await waitFor(() => expect(screen.getByRole("button", { name: /Send privately/ })).toBeEnabled());
}

function send() {
  fireEvent.click(screen.getByRole("button", { name: /Send privately/ }));
}

// Braces matter: a function returned from beforeEach is run as a teardown hook.
beforeEach(() => {
  resolveMock.mockReset();
});
afterEach(() => cleanup());

describe("SendView validates before entering the busy state (#922)", () => {
  it.each([
    ["a negative amount", "-1", /Invalid amount/],
    ["a zero amount", "0", /greater than 0/],
    ["a malformed amount", "1.2.3", /Invalid amount/],
  ])("rejects %s for a G-address without a registry lookup", async (_label, amount, message) => {
    await fill({ recipient: RECIPIENT_G, amount });
    send();

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(resolveMock).not.toHaveBeenCalled();
    expect(screen.queryByText(/Resolving stealth meta-address/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Send privately/ })).toBeEnabled();
  });

  it("rejects an over-long memo before the registry lookup", async () => {
    await fill({ recipient: RECIPIENT_G, amount: "1", memo: "x".repeat(40) });
    send();

    expect(await screen.findByText(/Memo must be 28 UTF-8 bytes/)).toBeInTheDocument();
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it("only enters the busy state once validation passes, and reports an unregistered address", async () => {
    resolveMock.mockResolvedValue(null);
    await fill({ recipient: RECIPIENT_G, amount: "1" });
    send();

    expect(await screen.findByText(/not registered in the stealth registry/)).toBeInTheDocument();
    expect(resolveMock).toHaveBeenCalledWith(RECIPIENT_G);
    expect(screen.getByRole("button", { name: /Send privately/ })).toBeEnabled();
  });

  it("distinguishes a registry outage from an unregistered address and leaves the busy state", async () => {
    resolveMock.mockImplementation(async () => {
      throw new Error("Failed to fetch");
    });
    await fill({ recipient: RECIPIENT_G, amount: "1" });
    send();

    expect(await screen.findByText(/Could not reach the stealth registry: Failed to fetch/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Send privately/ })).toBeEnabled();
  });
});
