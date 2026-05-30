#!/usr/bin/env node
/**
 * Validates mainnet security audit findings and signoff status.
 *
 * Usage:
 *   node scripts/verify-security-audit.mjs
 *   node scripts/verify-security-audit.mjs --network mainnet
 *   node scripts/verify-security-audit.mjs --network mainnet --require-approved
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const FINDINGS_PATH = join(ROOT, "docs", "security", "mainnet-audit-findings.json");
const MAINNET_MANIFEST = join(ROOT, "deployments", "v1", "mainnet.json");

function parseArgs(argv) {
  const opts = { network: null, requireApproved: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--network" && argv[i + 1]) opts.network = argv[++i];
    else if (argv[i] === "--require-approved") opts.requireApproved = true;
  }
  return opts;
}

function loadJson(path) {
  if (!existsSync(path)) throw new Error(`Missing file: ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function validateFindings(data) {
  if (data.schemaVersion !== "1.0.0") {
    throw new Error(`Unsupported findings schemaVersion: ${data.schemaVersion}`);
  }
  if (!Array.isArray(data.findings) || data.findings.length === 0) {
    throw new Error("Findings register must contain at least one finding");
  }
  const ids = new Set();
  for (const f of data.findings) {
    for (const key of ["id", "title", "component", "severity", "triage", "status"]) {
      if (!f[key]) throw new Error(`Finding ${f.id ?? "?"} missing field: ${key}`);
    }
    if (ids.has(f.id)) throw new Error(`Duplicate finding id: ${f.id}`);
    ids.add(f.id);
  }
}

function summarize(data) {
  const blockingOpen = data.findings.filter(
    (f) => f.triage === "blocking" && f.status === "open",
  );
  const remediated = data.findings.filter((f) => f.status === "remediated");
  const accepted = data.findings.filter((f) => f.status === "accepted_risk");
  return { blockingOpen, remediated, accepted };
}

function main() {
  const opts = parseArgs(process.argv);
  const findings = loadJson(FINDINGS_PATH);
  validateFindings(findings);

  const { blockingOpen, remediated, accepted } = summarize(findings);

  console.log("Security audit findings register OK");
  console.log(`  signoffStatus: ${findings.signoffStatus}`);
  console.log(`  total findings: ${findings.findings.length}`);
  console.log(`  blocking open: ${blockingOpen.length}`);
  console.log(`  remediated: ${remediated.length}`);
  console.log(`  accepted risk: ${accepted.length}`);

  if (blockingOpen.length > 0) {
    console.log("\nOpen blocking findings:");
    for (const f of blockingOpen) {
      console.log(`  - ${f.id}: ${f.title}`);
    }
  }

  let requireApproval = opts.requireApproved;
  if (opts.network === "mainnet") {
    const manifest = loadJson(MAINNET_MANIFEST);
    if (manifest.deploymentStatus === "deployed") {
      requireApproval = true;
      console.log("\nmainnet.json deploymentStatus is 'deployed' — requiring approved signoff");
    }
  }

  if (requireApproval) {
    if (findings.signoffStatus !== "approved") {
      console.error(
        `\nERROR: signoffStatus is '${findings.signoffStatus}', expected 'approved' for mainnet.`,
      );
      console.error("See docs/security/MAINNET_AUDIT_SIGNOFF.md");
      process.exit(1);
    }
    if (blockingOpen.length > 0) {
      console.error("\nERROR: open blocking findings remain. Mainnet deploy is not allowed.");
      process.exit(1);
    }
    console.log("\nOK: mainnet security audit approved — no open blocking findings");
  } else if (findings.signoffStatus !== "approved" || blockingOpen.length > 0) {
    console.log("\nNote: mainnet deploy blocked until signoff approved and blocking findings closed.");
    console.log("  Run with --require-approved to enforce before production deploy.");
  }

  process.exit(0);
}

main();
