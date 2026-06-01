import { describe, it, expect, afterEach, vi } from "vitest";
import {
  assessBrowserSupport,
  MOBILE_FLOW_CHECKLIST,
} from "../browserSupport";

describe("browserSupport", () => {
  it("returns an assessment with capability list", () => {
    const assessment = assessBrowserSupport("Mozilla/5.0 Chrome/120");
    expect(["supported", "limited", "unsupported"]).toContain(assessment.level);
    expect(assessment.userAgent).toContain("Chrome");
  });

  it("flags mobile user agents as limited with warning", () => {
    const assessment = assessBrowserSupport(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
    );
    expect(assessment.isMobile).toBe(true);
    expect(assessment.warnings.some((w) => w.includes("Mobile"))).toBe(true);
  });

  it("exports mobile flow checklist for manual QA", () => {
    expect(MOBILE_FLOW_CHECKLIST.length).toBeGreaterThanOrEqual(5);
    expect(MOBILE_FLOW_CHECKLIST).toContain("Connect Freighter wallet");
    expect(MOBILE_FLOW_CHECKLIST).toContain("Receive via payment link");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("marks browsers without WebAssembly as unsupported", () => {
    vi.stubGlobal("WebAssembly", undefined);
    const assessment = assessBrowserSupport("Mozilla/5.0 Chrome/120");
    expect(assessment.level).toBe("unsupported");
    expect(assessment.missing).toContain("webassembly");
  });
});
