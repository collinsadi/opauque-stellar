# Circuit Benchmarks

This directory contains the benchmark suite for measuring proof generation performance across device profiles.

## Quick Start

```bash
cd circuits/benchmarks
npm install
npm run bench
```

## Usage

### Benchmark V2 Circuit (default)

```bash
npm run bench:v2
```

### Benchmark All Circuits

```bash
npm run bench:all
```

### CI Mode

```bash
npm run bench:ci
```

CI mode exits with error if any benchmark exceeds P95 targets.

## Device Profiles

The benchmark suite detects the current device profile based on available memory:

| Profile | Memory | CPU Multiplier | Description |
|:--------|:-------|:---------------|:------------|
| high-end-desktop | ≥14GB | 1.0x | Desktop workstation |
| mid-tier-laptop | ≥6GB | 1.5x | Standard laptop |
| mobile-premium | ≥3GB | 2.5x | High-end mobile device |
| mobile-budget | <3GB | 4.0x | Budget mobile device |

## P95 Targets for Mobile

| Metric | Target |
|:-------|:-------|
| Witness generation | ≤ 30,000ms (30s) |
| Proof generation | ≤ 120,000ms (2min) |
| Total | ≤ 150,000ms (2.5min) |
| Proof size | ≤ 512 bytes |

Note: Targets assume mid-tier mobile device (2024+). Budget devices may exceed targets by 2-4x.

## Results

Results are stored in `circuits/benchmarks/results/`:
- `benchmark-<timestamp>.json` - Timestamped benchmark results
- `latest.json` - Most recent benchmark results (used by CI)

## CI Integration

Add to `.github/workflows/ci.yml`:

```yaml
- name: Run circuit benchmarks
  run: |
    cd circuits/benchmarks
    npm install
    npm run bench:ci
```

## Interpreting Results

- **Witness generation**: Time to prepare the circuit witness from inputs
- **Proof generation**: Time to generate the Groth16 proof from the witness
- **Proof size**: JSON-serialized proof size in bytes
- **Total**: Combined witness + proof generation time

## Adding New Benchmarks

To add benchmarks for a new circuit version:

1. Add the circuit config to `CIRCUIT_CONFIGS` in `benchmark-suite.ts`
2. Add the witness inputs for the circuit
3. Run `npm run bench:all` to include the new circuit
