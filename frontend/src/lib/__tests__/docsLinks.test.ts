import { describe, expect, it } from "vitest";
import { getDocUrl, getUserRecoverySectionUrl } from "../docsLinks";

describe("docsLinks", () => {
  it("builds GitHub doc URLs", () => {
    expect(getDocUrl("user-recovery")).toBe(
      "https://github.com/collinsadi/opaque-stellar/blob/main/docs/USER_RECOVERY.md",
    );
  });

  it("builds anchored section URLs", () => {
    expect(getUserRecoverySectionUrl("manual-ghost")).toBe(
      "https://github.com/collinsadi/opaque-stellar/blob/main/docs/USER_RECOVERY.md#manual-ghost-receives-one-time-browser-bound",
    );
  });
});
