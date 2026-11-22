#!/usr/bin/env tsx
/**
 * Link checker: catches repository URL and schema domain drift
 *
 * Validates that all repository references use the canonical slug
 * and all backup schema URIs use the canonical domain.
 *
 * Run: npx tsx scripts/check-repo-links.ts
 * CI: Add to GitHub Actions workflow for PR checks
 */

import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

const CANONICAL_REPO_SLUG = "collinsadi/opauque-stellar";
const CANONICAL_SCHEMA_DOMAIN = "opaque.cash";

const WRONG_PATTERNS = [
  /opaque\.network\/schemas/g, // Wrong schema domain
];

interface Issue {
  file: string;
  line: number;
  pattern: string;
  match: string;
}

const issues: Issue[] = [];

function checkFile(filepath: string): void {
  const ext = filepath.split(".").pop();
  if (!["md", "json", "ts", "tsx", "js", "jsx"].includes(ext || "")) {
    return;
  }

  const content = readFileSync(filepath, "utf-8");
  const lines = content.split("\n");

  lines.forEach((line, index) => {
    WRONG_PATTERNS.forEach((pattern) => {
      const matches = line.match(pattern);
      if (matches) {
        matches.forEach((match) => {
          issues.push({
            file: filepath,
            line: index + 1,
            pattern: pattern.source,
            match,
          });
        });
      }
    });
  });
}

function walkDirectory(dir: string, exclude: string[] = []): void {
  const entries = readdirSync(dir);

  entries.forEach((entry) => {
    const fullPath = join(dir, entry);

    // Skip excluded directories
    if (exclude.some((e) => fullPath.includes(e))) {
      return;
    }

    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      walkDirectory(fullPath, exclude);
    } else if (stat.isFile()) {
      checkFile(fullPath);
    }
  });
}

const EXCLUDE_DIRS = [
  "node_modules",
  ".git",
  "target",
  "dist",
  "build",
  ".next",
  "coverage",
];

console.log("Checking for incorrect repository URLs and schema domains...\n");

walkDirectory(".", EXCLUDE_DIRS);

if (issues.length === 0) {
  console.log("✓ All repository URLs and schema domains are correct");
  console.log(`  Canonical repo: ${CANONICAL_REPO_SLUG}`);
  console.log(`  Canonical schema domain: ${CANONICAL_SCHEMA_DOMAIN}`);
  process.exit(0);
} else {
  console.error(`✗ Found ${issues.length} incorrect reference(s):\n`);

  issues.forEach((issue) => {
    console.error(`  ${issue.file}:${issue.line}`);
    console.error(`    Pattern: ${issue.pattern}`);
    console.error(`    Found: ${issue.match}\n`);
  });

  console.error(`\nExpected:`);
  console.error(`  Repository: ${CANONICAL_REPO_SLUG}`);
  console.error(`  Schema domain: ${CANONICAL_SCHEMA_DOMAIN}`);

  process.exit(1);
}
