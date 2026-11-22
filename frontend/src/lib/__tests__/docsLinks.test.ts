import { describe, expect, it } from "vitest";
import { getDocUrl, getUserRecoverySectionUrl } from "../docsLinks";

describe("docsLinks", () => {
  it("builds GitHub doc URLs with valid anchors", () => {
    expect(getDocUrl("user-recovery")).toBe(
      "https://github.com/collinsadi/opauque-stellar/blob/main/README.md#honest-trade-offs",
    );
    expect(getDocUrl("ghost-threat-model")).toBe(
      "https://github.com/collinsadi/opauque-stellar/blob/main/README.md#where-the-zero-knowledge-does-the-work",
    );
    expect(getDocUrl("payment-link-format")).toBe(
      "https://github.com/collinsadi/opauque-stellar/blob/main/README.md#what-opaque-does",
    );
    expect(getDocUrl("privacy-pool")).toBe(
      "https://github.com/collinsadi/opauque-stellar/blob/main/README.md#where-the-zero-knowledge-does-the-work",
    );
  });

  it("links to proof submission privacy guidance", () => {
    expect(getDocUrl("proof-submission-privacy")).toBe(
      "https://github.com/collinsadi/opauque-stellar/blob/main/docs/PROOF_SUBMISSION_PRIVACY.md",
    );
  });

  it("links privacy-doc entries to their relevant sections", () => {
    expect(getDocUrl("pool-linkability")).toBe(
      "https://github.com/collinsadi/opauque-stellar/blob/main/docs/PRIVACY_GUARANTEES.md#pool-deposit-linkability",
    );
    expect(getDocUrl("horizon-history-sync")).toBe(
      "https://github.com/collinsadi/opauque-stellar/blob/main/docs/PRIVACY_GUARANTEES.md#horizon-history-sync",
    );
  });

  it("maps recovery sections to their actual headings", () => {
    expect(getUserRecoverySectionUrl("payment-link")).toBe(
      "https://github.com/collinsadi/opauque-stellar/blob/main/README.md#where-the-zero-knowledge-does-the-work",
    );
    expect(getUserRecoverySectionUrl("manual-ghost")).toBe(
      "https://github.com/collinsadi/opauque-stellar/blob/main/README.md#where-the-zero-knowledge-does-the-work",
    );
    expect(getUserRecoverySectionUrl("signature-keys")).toBe(
      "https://github.com/collinsadi/opauque-stellar/blob/main/README.md#security",
    );
    expect(getUserRecoverySectionUrl("browser-session")).toBe(
      "https://github.com/collinsadi/opauque-stellar/blob/main/README.md#security",
    );
    expect(getUserRecoverySectionUrl("ghost-backup")).toBe(
      "https://github.com/collinsadi/opauque-stellar/blob/main/README.md#honest-trade-offs",
    );
    expect(getUserRecoverySectionUrl("device-migration")).toBe(
      "https://github.com/collinsadi/opauque-stellar/blob/main/README.md#honest-trade-offs",
    );
    expect(getUserRecoverySectionUrl("what-to-backup")).toBe(
      "https://github.com/collinsadi/opauque-stellar/blob/main/README.md#honest-trade-offs",
    );
  });
});
