/**
 * @vitest-environment jsdom
 *
 * Payment links that fail validation cannot be paid, and memos are disclosed
 * before sending (#1099, #1100).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { createPaymentLink } from "../lib/paymentLink";

const META = "0x02" + "a".repeat(64) + "03" + "b".repeat(64);
const ISSUER = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const identifier = vi.hoisted(() => ({ current: "" as string }));

vi.mock("react-router-dom", () => ({
  useParams: () => ({ identifier: identifier.current }),
  useNavigate: () => vi.fn(),
}));
vi.mock("../hooks/useWallet", () => ({
  useWallet: () => ({
    publicKey: ISSUER,
    connected: true,
    connecting: false,
    signTransaction: vi.fn(),
    connect: vi.fn(),
  }),
}));
vi.mock("../lib/chain", () => ({
  getCluster: () => "testnet",
  getNetwork: () => "testnet",
  getHorizonUrls: () => ["https://horizon.test"],
  getRpcUrls: () => ["https://rpc.test"],
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
vi.mock("../store/pendingTxStore", () => ({
  usePendingTxStore: () => ({ byHash: {}, add: vi.fn(), setStatus: vi.fn() }),
}));

import { PayPage } from "../components/PayPage";

function webIdentifier(link: string) {
  return btoa(link).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

beforeEach(() => {
  identifier.current = "";
});
afterEach(() => cleanup());

describe("PayPage link validation (#1099)", () => {
  it("renders the Send button and prefilled amount for a valid link", async () => {
    identifier.current = webIdentifier(
      createPaymentLink(META, "testnet", { amount: "7" }),
    );
    render(<PayPage />);

    expect(await screen.findByRole("button", { name: "Send XLM" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Amount in XLM")).toHaveValue("7");
  });

  it("blocks sending and shows the error for a non-native asset link", async () => {
    identifier.current = webIdentifier(
      createPaymentLink(META, "testnet", { asset: "USDC", issuer: ISSUER }),
    );
    render(<PayPage />);

    expect(await screen.findByText(/non-native asset/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send XLM" })).not.toBeInTheDocument();
  });

  it("blocks sending and shows the specific reason for an expired link", async () => {
    identifier.current = createPaymentLink(META, "testnet", {
      expires: new Date(Date.now() - 60_000).toISOString(),
    });
    render(<PayPage />);

    expect(await screen.findByText(/has expired/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send XLM" })).not.toBeInTheDocument();
  });

  it("shows the network mismatch screen for a link on another network", async () => {
    identifier.current = createPaymentLink(META, "mainnet");
    render(<PayPage />);

    expect(await screen.findByText("Network Mismatch")).toBeInTheDocument();
    expect(screen.getByText(/Network mismatch/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send XLM" })).not.toBeInTheDocument();
  });
});

describe("PayPage memo disclosure (#1100)", () => {
  it("warns that a link memo is public before sending", async () => {
    identifier.current = webIdentifier(
      createPaymentLink(META, "testnet", { amount: "2", memo: "invoice-9" }),
    );
    render(<PayPage />);

    expect(await screen.findByRole("button", { name: "Send XLM" })).toBeInTheDocument();
    expect(screen.getByText(/Memos are public/)).toBeInTheDocument();
    expect(screen.getByText(/permanently visible on-chain/)).toBeInTheDocument();
  });

  it("does not warn when the link has no memo", async () => {
    identifier.current = webIdentifier(createPaymentLink(META, "testnet"));
    render(<PayPage />);

    expect(await screen.findByRole("button", { name: "Send XLM" })).toBeInTheDocument();
    expect(screen.queryByText(/Memos are public/)).not.toBeInTheDocument();
  });
});
