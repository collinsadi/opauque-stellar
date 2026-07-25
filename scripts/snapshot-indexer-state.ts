#!/usr/bin/env -S npx tsx
/**
 * Snapshot and restore scanner/indexer state (#626)
 * Enables fast ASP recovery after disk loss by preserving indexed ledger position.
 *
 * Usage: npx tsx scripts/snapshot-indexer-state.ts [create|restore] [--output FILE] [--input FILE]
 */

import * as fs from "fs";
import * as path from "path";

interface IndexerSnapshot {
  version: 1;
  timestamp: string;
  lastProcessedLedger: number;
  processedEvents: number;
  indexedAnnouncements: number;
  checksumLastLedger: string;
}

const DEFAULT_SNAPSHOT_PATH = ".indexer-state/snapshot.json";

function getSnapshotPath(outputPath?: string): string {
  if (outputPath) return outputPath;
  return path.join(process.cwd(), DEFAULT_SNAPSHOT_PATH);
}

function getCurrentLedger(): number {
  const env = process.env.LAST_PROCESSED_LEDGER || "0";
  return parseInt(env, 10);
}

function createSnapshot(outputPath?: string): void {
  const snapshotPath = getSnapshotPath(outputPath);
  const snapshotDir = path.dirname(snapshotPath);

  if (!fs.existsSync(snapshotDir)) {
    fs.mkdirSync(snapshotDir, { recursive: true });
  }

  const lastLedger = getCurrentLedger();
  const snapshot: IndexerSnapshot = {
    version: 1,
    timestamp: new Date().toISOString(),
    lastProcessedLedger: lastLedger,
    processedEvents: 0,
    indexedAnnouncements: 0,
    checksumLastLedger: lastLedger.toString(),
  };

  fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));
  console.log(`✓ Snapshot created: ${snapshotPath}`);
  console.log(`  Last processed ledger: ${lastLedger}`);
  console.log(`  Timestamp: ${snapshot.timestamp}`);
}

function restoreSnapshot(inputPath?: string): void {
  const snapshotPath = getSnapshotPath(inputPath);

  if (!fs.existsSync(snapshotPath)) {
    console.error(`✗ Snapshot not found: ${snapshotPath}`);
    process.exit(1);
  }

  const snapshot: IndexerSnapshot = JSON.parse(
    fs.readFileSync(snapshotPath, "utf-8"),
  );

  if (snapshot.version !== 1) {
    console.error("✗ Unsupported snapshot version:", snapshot.version);
    process.exit(1);
  }

  const age = new Date().getTime() - new Date(snapshot.timestamp).getTime();
  const daysSinceSnapshot = age / (1000 * 60 * 60 * 24);

  console.log(`✓ Snapshot loaded from: ${snapshotPath}`);
  console.log(`  Created: ${snapshot.timestamp} (${daysSinceSnapshot.toFixed(1)} days ago)`);
  console.log(`  Last processed ledger: ${snapshot.lastProcessedLedger}`);
  console.log(`  Processed events: ${snapshot.processedEvents}`);
  console.log(`  Indexed announcements: ${snapshot.indexedAnnouncements}`);
  console.log();
  console.log(
    "To resume indexing from this point, set environment variable:",
  );
  console.log(
    `  LAST_PROCESSED_LEDGER=${snapshot.lastProcessedLedger}`,
  );

  if (daysSinceSnapshot > 7) {
    console.warn();
    console.warn(
      `⚠ Warning: Snapshot is ${daysSinceSnapshot.toFixed(1)} days old.`,
    );
    console.warn(
      "  Consider re-indexing recent ledgers to ensure consistency.",
    );
  }
}

function listSnapshots(): void {
  const snapshotDir = path.dirname(getSnapshotPath());

  if (!fs.existsSync(snapshotDir)) {
    console.log("No snapshots found.");
    return;
  }

  const files = fs.readdirSync(snapshotDir).filter((f) => f.endsWith(".json"));

  if (files.length === 0) {
    console.log("No snapshots found.");
    return;
  }

  console.log("Available snapshots:");
  for (const file of files) {
    const filePath = path.join(snapshotDir, file);
    const stat = fs.statSync(filePath);
    console.log(`  ${file} (${stat.size} bytes, ${stat.mtime.toISOString()})`);
  }
}

const args = process.argv.slice(2);
const command = args[0] || "create";

switch (command) {
  case "create":
    createSnapshot(args[args.indexOf("--output") + 1]);
    break;
  case "restore":
    restoreSnapshot(args[args.indexOf("--input") + 1]);
    break;
  case "list":
    listSnapshots();
    break;
  default:
    console.log(`
Usage: npx tsx scripts/snapshot-indexer-state.ts [command] [options]

Commands:
  create    Create a snapshot of current indexer state (default)
  restore   Restore indexer state from snapshot
  list      List available snapshots

Options:
  --output FILE   Save snapshot to FILE (default: .indexer-state/snapshot.json)
  --input FILE    Load snapshot from FILE

Examples:
  npx tsx scripts/snapshot-indexer-state.ts create
  npx tsx scripts/snapshot-indexer-state.ts restore
  npx tsx scripts/snapshot-indexer-state.ts list
`);
}
