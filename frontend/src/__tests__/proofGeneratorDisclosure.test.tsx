/**
 * @vitest-environment jsdom
 *
 * ProofGeneratorModal must not claim "No private data leaves your browser" (#920):
 * it POSTs the leaf commitment and attestation metadata to the reputation publisher.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, cleanup } from "@testing-library/react";

vi.mock("snarkjs", () => ({ groth16: { fullProve: vi.fn() } }));
vi.mock("circomlibjs", () => ({ buildPoseidon: vi.fn() }));
vi.mock("../hooks/useWallet", () => ({ useWallet: () => ({ publicKey: null, signTransaction: vi.fn() }) }));
vi.mock("../hooks/useOpaqueWasm", () => ({ useOpaqueWasm: () => ({ wasm: null, isReady: false }) }));
vi.mock("../context/KeysContext", () => ({ useKeys: () => ({ isSetup: true, getMasterKeys: vi.fn() }) }));
vi.mock("../hooks/useFreezeStatus", () => ({ useFreezeStatus: () => ({ frozen: false }) }));
vi.mock("../lib/opaqueCache", () => ({ getAnnouncementsForCluster: vi.fn(async () => []) }));
vi.mock("../lib/reputationProver", () => ({ submitProofOnChain: vi.fn() }));
vi.mock("../lib/reputationPublisher", () => ({ submitLeafAndFetchInclusion: vi.fn() }));

import { ProofGeneratorModal } from "../components/ProofGeneratorModal";
import type { V2DiscoveredTrait } from "../store/schemaStore";

afterEach(() => cleanup());

const trait = {
  stealthAddress: "0x" + "11".repeat(20),
  schemaId: "1",
  schemaName: "Test Schema",
  issuer: "GA5XIGA5C7QTPTWXQHY6MCJRMTRZDOSHR6EFIBNDQTCQHG262N4GGKTM",
  attestationUid: "uid-1",
  txHash: "ab".repeat(32),
  slot: 123,
  merkleLeafPreimage: { schemaIdField: "1" },
} as unknown as V2DiscoveredTrait;

describe("ProofGeneratorModal privacy disclosure (#920)", () => {
  it("does not claim that no data leaves the browser", () => {
    render(<ProofGeneratorModal trait={trait} onClose={vi.fn()} />);
    expect(document.body).not.toHaveTextContent(/No private data leaves your browser/i);
    expect(document.body).not.toHaveTextContent(/No private data left your browser/i);
  });

  it("names every field the publisher receives", () => {
    render(<ProofGeneratorModal trait={trait} onClose={vi.fn()} />);
    const disclosure = screen.getByTestId("publisher-disclosure");
    // Mirrors the ReputationLeafSubmission sent by submitLeafAndFetchInclusion.
    for (const field of [/leaf commitment/, /schema ID/, /attestation UID/, /transaction hash/, /ledger/, /IP address/]) {
      expect(disclosure).toHaveTextContent(field);
    }
    expect(disclosure).toHaveTextContent(/keys and the proof witness stay in this browser/);
  });
});
