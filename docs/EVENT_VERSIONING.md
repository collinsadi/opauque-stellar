# Event Schema Versioning

> Tracking issue: [#50 — Add event schema versioning](https://github.com/collinsadi/opauque-stellar/issues/50)

Scanners and indexers parse on-chain events positionally. When an event's topic
or data layout changes, an unversioned consumer can silently misparse the new
shape and corrupt its index. To make such changes explicit and detectable, every
contract event now carries a **schema version** as its second topic.

## On-chain format

Each event is published with the version immediately after the event name:

```
topics = (Symbol(<EventName>), EVENT_VERSION)
data   = (<unchanged per-event payload>)
```

`EVENT_VERSION` is a `const u32` defined in each contract. **Current value: `1`.**

Versioned events, by contract:

| Contract                | Event topics                              |
| ----------------------- | ----------------------------------------- |
| `stealth-announcer`     | `Announcement`                            |
| `stealth-registry`      | `StealthMetaAddressSet`, `NonceIncremented` |
| `schema-registry`       | `SchemaRegistered`                        |
| `attestation-engine-v2` | `AttestationCreated`, `AttestationRevoked` |
| `reputation-verifier`   | `MerkleRootPublished`, `ReputationVerified` |

## Scanner behaviour

The scanner (`scanner/src/lib.rs`) declares the single version it understands:

```rust
const SUPPORTED_EVENT_VERSION: u32 = 1;
```

When processing announcements it reads the `eventVersion` field and:

- **version matches** → process normally;
- **version present but unsupported** → skip the event with a telemetry warning
  (`console.warn` on wasm, `eprintln!` on native) and continue scanning;
- **version absent** → treated as compatible (legacy / pre-versioning events), so
  existing indexed history keeps working.

Skipping is **non-fatal**: one unsupported event never aborts a scan.

> **Indexer note:** the scanner reads the version from the `eventVersion` JSON
> field of each announcement record. Whatever indexes raw chain events into that
> JSON must copy the second event topic into `eventVersion`.

## How to change the schema

When you change an event's topics or data layout:

1. **Bump `EVENT_VERSION`** in the affected contract(s) (e.g. `1` → `2`).
2. **Update the scanner**: raise `SUPPORTED_EVENT_VERSION`, and — if you must keep
   reading older events — branch on the version to parse each layout.
3. **Add a row below** describing the change so operators know what differs.
4. **Re-deploy** contracts and scanner together; deploying one without the other
   is exactly the silent-break this mechanism is designed to surface.

## Version history

| Version | Change                                                              |
| ------- | ------------------------------------------------------------------- |
| `1`     | Initial versioned schema — version topic added to all contract events. |
