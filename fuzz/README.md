# Stealth announcer fuzz targets

These targets exercise the public `announce` entrypoint of the stealth-announcer contract with arbitrary values for the validation boundaries in issue #461:

- `announce-payload-length` varies metadata length, including empty input.
- `announce-scheme-id` varies the scheme identifier, including unsupported values.
- `announce-key-prefix` varies the first byte of a 33-byte compressed public key.

Install cargo-fuzz and run a target from `fuzz/`:

```sh
cargo fuzz run announce-payload-length -- -max_total_time=60
cargo fuzz run announce-scheme-id -- -max_total_time=60
cargo fuzz run announce-key-prefix -- -max_total_time=60
```

The targets use mocked authorization and an in-memory Soroban environment. They do not contact a network or write production state. Reproduce a crash with the artifact path printed by cargo-fuzz, then keep the regression test in `contracts/stealth-announcer/src/lib.rs`.
