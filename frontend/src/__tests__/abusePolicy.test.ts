import { describe, it, expect } from "vitest";
import {
  ABUSE_ACK_SLA_BUSINESS_DAYS,
  ABUSE_POLICY_ROUTE,
  INCIDENT_CONTACTS,
  INFRA_CAN_BLOCK,
  INFRA_CANNOT_BLOCK,
  PUBLIC_CONTACTS,
  REPORTER_PRIVACY_GUARANTEES,
} from "../lib/abusePolicy";

describe("abusePolicy", () => {
  it("exposes abuse policy route", () => {
    expect(ABUSE_POLICY_ROUTE).toBe("/abuse-policy");
  });

  it("documents public support and reporting contacts", () => {
    expect(PUBLIC_CONTACTS.abuse.email).toBe("abuse@opaqueprotocol.org");
    expect(PUBLIC_CONTACTS.security.email).toBe("security@opaqueprotocol.org");
    expect(PUBLIC_CONTACTS.support.url).toContain("github.com");
  });

  it("documents incident contacts for operators", () => {
    expect(INCIDENT_CONTACTS.incidentEmail).toBe("incident@opaqueprotocol.org");
    expect(INCIDENT_CONTACTS.opsChannel).toMatch(/ops/i);
  });

  it("defines infrastructure block limits", () => {
    expect(INFRA_CAN_BLOCK.length).toBeGreaterThan(0);
    expect(INFRA_CANNOT_BLOCK.length).toBeGreaterThan(INFRA_CAN_BLOCK.length - 1);
    expect(INFRA_CANNOT_BLOCK.some((item) => /non-custodial|immutable|third-party/i.test(item))).toBe(
      true,
    );
  });

  it("documents reporter privacy guarantees and SLA", () => {
    expect(REPORTER_PRIVACY_GUARANTEES.length).toBeGreaterThanOrEqual(3);
    expect(ABUSE_ACK_SLA_BUSINESS_DAYS).toBe(5);
  });
});
