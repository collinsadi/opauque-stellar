/**
 * @vitest-environment jsdom
 *
 * Payment link parameters are decoded and applied through the Send view (#1101).
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { createPaymentLink, createWebPaymentLink } from "../lib/paymentLink";

const META = "0x02" + "a".repeat(64) + "03" + "b".repeat(64);
const ISSUER = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

vi.mock("../context/KeysContext", () => ({ useKeys: () => ({ isSetup: true }) }));
vi.mock("../hooks/useWallet", () => ({
  useWallet: () => ({
    publicKey: ISSUER,
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

function recipientInput() {
  return screen.getByPlaceholderText(/payment link/);
}
function amountInput() {
  return screen.getByPlaceholderText("0.0") as HTMLInputElement;
}
function memoInput() {
  return screen.getByPlaceholderText("Optional") as HTMLInputElement;
}
function paste(value: string) {
  fireEvent.change(recipientInput(), { target: { value } });
}
function renderView() {
  return render(
    <MemoryRouter>
      <SendView />
    </MemoryRouter>,
  );
}

afterEach(() => cleanup());

describe("SendView payment link decoding (#1101)", () => {
  it("prefills amount and memo from a pasted opaque link", () => {
    renderView();
    paste(createPaymentLink(META, "testnet", { amount: "12.5", memo: "invoice-42" }));

    expect(amountInput()).toHaveValue("12.5");
    expect(memoInput()).toHaveValue("invoice-42");
    expect(screen.queryByText(/Network mismatch/)).not.toBeInTheDocument();
  });

  it("prefills amount and memo from a pasted web link", () => {
    renderView();
    paste(createWebPaymentLink(META, "testnet", { amount: "3", memo: "lunch" }));

    expect(amountInput()).toHaveValue("3");
    expect(memoInput()).toHaveValue("lunch");
  });

  it("shows the specific network mismatch reason", () => {
    renderView();
    paste(createPaymentLink(META, "mainnet", { amount: "1" }));
    expect(screen.getByText(/Network mismatch/)).toBeInTheDocument();
  });

  it("shows the specific expiry reason", () => {
    renderView();
    paste(
      createPaymentLink(META, "testnet", {
        expires: new Date(Date.now() - 60_000).toISOString(),
      }),
    );
    expect(screen.getByText(/has expired/)).toBeInTheDocument();
  });

  it("rejects a non-native asset link", () => {
    renderView();
    paste(createPaymentLink(META, "testnet", { asset: "USDC", issuer: ISSUER }));
    expect(screen.getByText(/non-native asset/)).toBeInTheDocument();
  });

  it("rejects an over-length memo link", () => {
    renderView();
    paste(
      `opaque://v1/testnet/${META}?memo=${encodeURIComponent("a".repeat(29))}`,
    );
    expect(screen.getByText(/28 UTF-8 bytes/)).toBeInTheDocument();
  });

  it("does not treat a plain meta-address as a payment link", () => {
    renderView();
    paste(META);
    expect(amountInput()).toHaveValue("");
    expect(memoInput()).toHaveValue("");
    expect(screen.queryByText(/Network mismatch|has expired|non-native asset/)).not.toBeInTheDocument();
  });
});
