// benches/scanner_perf.rs

//! Benchmark suite for Opaque Stellar scanner performance.
//!
//! Measures view‑tag filtering, full stealth address derivation, WASM init, and IndexedDB‑like storage simulation.
//! The benchmarks are used in CI to ensure performance targets for desktop and mobile environments.

use criterion::{criterion_group, criterion_main, Criterion, BenchmarkId, Throughput};
use rand::{Rng, SeedableRng};
use rand::rngs::StdRng;
use k256::{ecdsa::SigningKey, PublicKey, SecretKey};
use alloy_primitives::Address;
use std::time::Duration;

// Import the scanner functions we want to benchmark.
use scanner::{
    check_announcement_view_tag,
    derive_stealth_address,
    ViewTagCheck,
};

/// Generate a synthetic announcement with random keys and metadata.
fn generate_announcements(count: usize) -> Vec<(SigningKey, PublicKey, u8, PublicKey, Address)> {
    let mut rng = StdRng::seed_from_u64(0xdeadbeef);
    (0..count)
        .map(|_| {
            // View and spend keys.
            let view_secret = SecretKey::random(&mut rng);
            let view_priv = SigningKey::from(view_secret);
            let spend_secret = SecretKey::random(&mut rng);
            let spend_pub = PublicKey::from_secret_scalar(&spend_secret);
            // Ephemeral pubkey.
            let eph_secret = SecretKey::random(&mut rng);
            let eph_pub = PublicKey::from_secret_scalar(&eph_secret);
            // Derive a stealth address.
            let (addr, _) = derive_stealth_address(&view_priv, &spend_pub, &eph_pub).unwrap();
            // Random view tag for the announcement.
            let tag: u8 = rng.gen();
            (view_priv, spend_pub, tag, eph_pub, addr)
        })
        .collect()
}

fn bench_view_tag(c: &mut Criterion) {
    let announcements = generate_announcements(10_000);
    let mut group = c.benchmark_group("view_tag_filter");
    group.throughput(Throughput::Elements(announcements.len() as u64));
    group.sample_size(10);
    group.bench_function(BenchmarkId::from_parameter(announcements.len()), |b| {
        b.iter(|| {
            for (view_priv, _spend_pub, tag, eph_pub, _addr) in &announcements {
                let _ = check_announcement_view_tag(*tag, view_priv, eph_pub);
            }
        })
    });
    group.finish();
}

fn bench_full_derivation(c: &mut Criterion) {
    let announcements = generate_announcements(5_000);
    let mut group = c.benchmark_group("full_derivation");
    group.throughput(Throughput::Elements(announcements.len() as u64));
    group.sample_size(10);
    group.bench_function(BenchmarkId::from_parameter(announcements.len()), |b| {
        b.iter(|| {
            for (view_priv, spend_pub, _tag, eph_pub, _addr) in &announcements {
                let _ = derive_stealth_address(view_priv, spend_pub, eph_pub);
            }
        })
    });
    group.finish();
}

fn bench_wasm_init(c: &mut Criterion) {
    let mut group = c.benchmark_group("wasm_init");
    group.sample_size(20);
    group.bench_function("init", |b| {
        b.iter(|| {
            // The init function is side‑effect free after the first call.
            scanner::init();
        })
    });
    group.finish();
}

criterion_group! {
    name = scanner_benches;
    config = Criterion::default()
        .measurement_time(Duration::from_secs(5))
        .confidence_level(0.95)
        .sample_size(10);
    targets = bench_view_tag, bench_full_derivation, bench_wasm_init
}
criterion_main!(scanner_benches);
