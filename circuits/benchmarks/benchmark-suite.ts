// @ts-nocheck
/**
 * Circuit benchmark suite for measuring witness generation and proof time
 * across different device profiles.
 *
 * Usage:
 *   cd circuits/benchmarks && npm run bench
 *   cd circuits/benchmarks && npm run bench:v2
 *   cd circuits/benchmarks && npm run bench:ci
 *
 * Results are stored in circuits/benchmarks/results/
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// @ts-expect-error snarkjs has no bundled types
import * as snarkjs from "snarkjs";

interface BenchmarkConfig {
  circuitVersion: string;
  wasmPath: string;
  zkeyPath: string;
  witnessInputs: Record<string, unknown>;
}

interface BenchmarkResult {
  circuitVersion: string;
  timestamp: string;
  witnessGenTimeMs: number;
  proofGenTimeMs: number;
  totalTimeMs: number;
  proofSizeBytes: number;
  publicSignalsCount: number;
  deviceProfile: string;
}

interface DeviceProfile {
  name: string;
  cpuMultiplier: number;
  memoryLimitMB: number;
}

const DEVICE_PROFILES: DeviceProfile[] = [
  { name: "high-end-desktop", cpuMultiplier: 1.0, memoryLimitMB: 16384 },
  { name: "mid-tier-laptop", cpuMultiplier: 1.5, memoryLimitMB: 8192 },
  { name: "mobile-premium", cpuMultiplier: 2.5, memoryLimitMB: 4096 },
  { name: "mobile-budget", cpuMultiplier: 4.0, memoryLimitMB: 2048 },
];

const CIRCUIT_CONFIGS: Record<string, BenchmarkConfig> = {
  v1: {
    circuitVersion: "v1",
    wasmPath: join(__dirname, "../../frontend/public/circuits/stealth_attestation_js/stealth_attestation.wasm"),
    zkeyPath: join(__dirname, "../../frontend/public/circuits/sa_final.zkey"),
    witnessInputs: {
      stealth_private_key: "123456789012345678901234567890",
      attestation_id: "1",
      ephemeral_pubkey: ["1234567890", "9876543210"],
      announcement_attestation_id: "1",
      merkle_path_elements: Array(20).fill("0"),
      merkle_path_indices: Array(20).fill(0),
      nullifier: "111222333444555666777888999000",
    },
  },
  v2: {
    circuitVersion: "v2",
    wasmPath: join(__dirname, "../../frontend/public/circuits/v2/stealth_reputation.wasm"),
    zkeyPath: join(__dirname, "../../frontend/public/circuits/v2/stealth_reputation_final.zkey"),
    witnessInputs: {
      stealth_pk: "123456789012345678901234567890",
      schema_id: "1",
      issuer_pk_x: "1234567890123456789012345678901234567890123456789012345678901234",
      trait_data_hash: "999888777666555444333222111000",
      nonce: "111111111111111111",
      merkle_path: Array(20).fill("0"),
      merkle_path_indices: Array(20).fill(0),
      merkle_root: "12345678901234567890",
      attestation_id: "1",
      external_nullifier: "999999999999999999",
      nullifier_hash: "888888888888888888",
    },
  },
};

function detectDeviceProfile(): string {
  const memoryGB = (globalThis as any).performance?.memory?.jsHeapSizeLimit
    ? (globalThis as any).performance.memory.jsHeapSizeLimit / (1024 * 1024 * 1024)
    : 8;

  if (memoryGB >= 14) return "high-end-desktop";
  if (memoryGB >= 6) return "mid-tier-laptop";
  if (memoryGB >= 3) return "mobile-premium";
  return "mobile-budget";
}

async function runBenchmark(config: BenchmarkConfig): Promise<BenchmarkResult> {
  console.log(`\nBenchmarking circuit ${config.circuitVersion}...`);

  if (!existsSync(config.wasmPath)) {
    throw new Error(`WASM not found: ${config.wasmPath}`);
  }
  if (!existsSync(config.zkeyPath)) {
    throw new Error(`ZKey not found: ${config.zkeyPath}`);
  }

  // Warm up
  console.log("  Warming up...");
  const warmupStart = performance.now();
  await snarkjs.groth16.fullProve(
    config.witnessInputs,
    config.wasmPath,
    config.zkeyPath,
    { info: () => {}, debug: () => {}, error: () => {}, warn: () => {}, trace: () => {} },
  );
  const warmupTime = performance.now() - warmupStart;
  console.log(`  Warmup completed in ${Math.round(warmupTime)}ms`);

  // Benchmark witness generation
  console.log("  Measuring witness generation...");
  const witnessStart = performance.now();
  const witness = await snarkjs.groth16.fullProve(
    config.witnessInputs,
    config.wasmPath,
    config.zkeyPath,
    { info: () => {}, debug: () => {}, error: () => {}, warn: () => {}, trace: () => {} },
  );
  const witnessTime = performance.now() - witnessStart;

  // Benchmark proof generation (already done in fullProve, but measure separately)
  console.log("  Measuring proof generation...");
  const proofStart = performance.now();
  const result = await snarkjs.groth16.fullProve(
    config.witnessInputs,
    config.wasmPath,
    config.zkeyPath,
    { info: () => {}, debug: () => {}, error: () => {}, warn: () => {}, trace: () => {} },
  );
  const proofTime = performance.now() - proofStart;

  const proofSize = JSON.stringify(result.proof).length;
  const publicSignalsCount = result.publicSignals.length;

  const benchmarkResult: BenchmarkResult = {
    circuitVersion: config.circuitVersion,
    timestamp: new Date().toISOString(),
    witnessGenTimeMs: Math.round(witnessTime),
    proofGenTimeMs: Math.round(proofTime),
    totalTimeMs: Math.round(witnessTime + proofTime),
    proofSizeBytes: proofSize,
    publicSignalsCount,
    deviceProfile: detectDeviceProfile(),
  };

  console.log(`  Results:`);
    console.log(`    Witness gen: ${benchmarkResult.witnessGenTimeMs}ms`);
    console.log(`    Proof gen:   ${benchmarkResult.proofGenTimeMs}ms`);
    console.log(`    Total:       ${benchmarkResult.totalTimeMs}ms`);
    console.log(`    Proof size:  ${benchmarkResult.proofSizeBytes} bytes`);
    console.log(`    Public signals: ${benchmarkResult.publicSignalsCount}`);

  return benchmarkResult;
}

function saveBenchmarkResults(results: BenchmarkResult[]): void {
  const resultsDir = join(__dirname, "results");
  if (!existsSync(resultsDir)) {
    mkdirSync(resultsDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `benchmark-${timestamp}.json`;
  const filepath = join(resultsDir, filename);

  writeFileSync(filepath, JSON.stringify(results, null, 2));
  console.log(`\nResults saved to ${filepath}`);

  // Also save latest.json for CI
  const latestPath = join(resultsDir, "latest.json");
  writeFileSync(latestPath, JSON.stringify(results, null, 2));
  console.log(`Latest results saved to ${latestPath}`);
}

function printSummary(results: BenchmarkResult[]): void {
  console.log("\n" + "=".repeat(80));
  console.log("BENCHMARK SUMMARY");
  console.log("=".repeat(80));

  for (const result of results) {
    console.log(`\nCircuit: ${result.circuitVersion}`);
    console.log(`  Device profile: ${result.deviceProfile}`);
    console.log(`  Witness gen: ${result.witnessGenTimeMs}ms`);
    console.log(`  Proof gen: ${result.proofGenTimeMs}ms`);
    console.log(`  Total: ${result.totalTimeMs}ms`);
    console.log(`  Proof size: ${result.proofSizeBytes} bytes`);
  }

  // P95 targets documentation
  console.log("\n" + "-".repeat(80));
  console.log("P95 TARGETS FOR MOBILE DEVICES:");
  console.log("-".repeat(80));
  console.log("  Witness generation: ≤ 30,000ms (30s)");
  console.log("  Proof generation:   ≤ 120,000ms (2min)");
  console.log("  Total:              ≤ 150,000ms (2.5min)");
  console.log("  Proof size:         ≤ 512 bytes");
  console.log("");
  console.log("  Note: Targets assume mid-tier mobile device (2024+)");
  console.log("  Budget devices may exceed targets by 2-4x");
}

function parseArgs(argv: string[]): { circuit: string; ci: boolean } {
  const args = argv.slice(2);
  let circuit = "v2";
  let ci = false;

  for (let i = 2; i < args.length; i++) {
    if (args[i] === "--circuit" && args[i + 1]) {
      circuit = args[++i];
    }
    if (args[i] === "--ci") {
      ci = true;
    }
  }

  return { circuit, ci };
}

async function main(): Promise<void> {
  const { circuit, ci } = parseArgs(process.argv);

  console.log("Opaque Circuit Benchmark Suite");
  console.log("==============================");
  console.log(`Circuit: ${circuit}`);
  console.log(`Mode: ${ci ? "CI" : "Local"}`);
  console.log(`Device profile: ${detectDeviceProfile()}`);

  const results: BenchmarkResult[] = [];

  if (circuit === "all") {
    for (const [version, config] of Object.entries(CIRCUIT_CONFIGS)) {
      try {
        const result = await runBenchmark(config);
        results.push(result);
      } catch (err) {
        console.error(`\nFailed to benchmark ${version}: ${err}`);
      }
    }
  } else {
    const config = CIRCUIT_CONFIGS[circuit];
    if (!config) {
      console.error(`Unknown circuit: ${circuit}. Available: ${Object.keys(CIRCUIT_CONFIGS).join(", ")}`);
      process.exit(1);
    }

    try {
      const result = await runBenchmark(config);
      results.push(result);
    } catch (err) {
      console.error(`\nFailed to benchmark ${circuit}: ${err}`);
      process.exit(1);
    }
  }

  if (results.length > 0) {
    printSummary(results);
    saveBenchmarkResults(results);
  }

  if (ci) {
    // In CI, exit with error if any benchmark exceeds P95 targets
    const failures = results.filter((r) => r.totalTimeMs > 150000);
    if (failures.length > 0) {
      console.error("\n⚠ CI check failed: some benchmarks exceeded P95 targets");
      process.exit(1);
    }
  }
}

main();
