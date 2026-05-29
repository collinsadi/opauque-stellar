# Stellar Announcement Indexer

## Problem

Browser-only scanning over RPC is slow, fragile, and incomplete on mainnet:

- **Slow**: Scanning 1000s of ledgers takes minutes
- **Fragile**: RPC rate limits, timeouts, node failures
- **Incomplete**: Can't backfill historical announcements
- **Inefficient**: Every client rescans the same data

## Solution

Build an indexer service that:

1. Consumes Soroban events from ledger stream
2. Stores announcement data in database
3. Exposes paginated APIs for clients
4. Publishes signed snapshots for verification

## Architecture

```
Stellar Network
    ↓ (Soroban events)
Indexer Service
    ├─ Event Consumer (backfill + live)
    ├─ Database (PostgreSQL)
    ├─ API Server (REST)
    └─ Snapshot Publisher (signed)
         ↓
Client (Browser)
    ├─ Fetch announcements via API
    ├─ Verify snapshot signature
    └─ Scan locally
```

## Components

### 1. Event Consumer

**Responsibility**: Consume Soroban events from Stellar ledger stream

**Implementation**:

```rust
// indexer/src/consumer.rs

use soroban_sdk::Env;
use stellar_sdk::Client;

pub struct EventConsumer {
    client: Client,
    db: Database,
    last_ledger: u32,
}

impl EventConsumer {
    /// Backfill announcements from deployment ledger to current
    pub async fn backfill(&mut self, from_ledger: u32) -> Result<u32, Error> {
        let mut current = from_ledger;
        let latest = self.client.get_latest_ledger().await?;

        while current <= latest {
            let events = self.client.get_events(current).await?;

            for event in events {
                if event.is_announcement() {
                    self.db.store_announcement(event).await?;
                }
            }

            current += 1;
        }

        self.last_ledger = latest;
        Ok(latest)
    }

    /// Poll for new announcements (live mode)
    pub async fn poll_live(&mut self) -> Result<u32, Error> {
        let latest = self.client.get_latest_ledger().await?;

        if latest > self.last_ledger {
            let events = self.client.get_events_range(self.last_ledger + 1, latest).await?;

            for event in events {
                if event.is_announcement() {
                    self.db.store_announcement(event).await?;
                }
            }

            self.last_ledger = latest;
        }

        Ok(latest)
    }
}
```

### 2. Database Schema

**PostgreSQL schema for announcements**:

```sql
CREATE TABLE announcements (
    id BIGSERIAL PRIMARY KEY,
    ledger_sequence INTEGER NOT NULL,
    tx_hash VARCHAR(64) NOT NULL,
    event_index INTEGER NOT NULL,

    -- Announcement fields
    scheme_id BIGINT NOT NULL,
    stealth_address BYTEA NOT NULL,
    caller VARCHAR(56) NOT NULL,  -- Stellar address
    ephemeral_pub_key BYTEA NOT NULL,
    metadata BYTEA NOT NULL,

    -- Indexing
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    UNIQUE(ledger_sequence, tx_hash, event_index),
    INDEX idx_ledger (ledger_sequence),
    INDEX idx_stealth_address (stealth_address),
    INDEX idx_caller (caller),
    INDEX idx_created_at (created_at)
);

CREATE TABLE indexer_state (
    id INTEGER PRIMARY KEY,
    last_indexed_ledger INTEGER NOT NULL,
    last_snapshot_ledger INTEGER NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE snapshots (
    id BIGSERIAL PRIMARY KEY,
    ledger_sequence INTEGER NOT NULL,
    announcement_count INTEGER NOT NULL,
    data_hash VARCHAR(64) NOT NULL,
    signature VARCHAR(128) NOT NULL,
    signer_public_key VARCHAR(56) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    UNIQUE(ledger_sequence),
    INDEX idx_ledger (ledger_sequence)
);
```

### 3. API Server

**REST API for clients**:

```typescript
// indexer/src/api.rs

#[get("/announcements")]
pub async fn list_announcements(
    Query(params): Query<ListParams>,
    db: web::Data<Database>,
) -> Result<Json<ListResponse>> {
    // Pagination by ledger or cursor
    let announcements = db.list_announcements(
        params.from_ledger,
        params.limit,
        params.cursor,
    ).await?;

    Ok(Json(ListResponse {
        announcements,
        next_cursor: announcements.last().map(|a| a.id.to_string()),
        total_count: db.count_announcements().await?,
    }))
}

#[get("/announcements/by-address/{address}")]
pub async fn list_by_address(
    Path(address): Path<String>,
    Query(params): Query<ListParams>,
    db: web::Data<Database>,
) -> Result<Json<ListResponse>> {
    let announcements = db.list_by_stealth_address(
        &address,
        params.from_ledger,
        params.limit,
    ).await?;

    Ok(Json(ListResponse {
        announcements,
        next_cursor: announcements.last().map(|a| a.id.to_string()),
        total_count: db.count_by_address(&address).await?,
    }))
}

#[get("/snapshots/latest")]
pub async fn get_latest_snapshot(
    db: web::Data<Database>,
) -> Result<Json<Snapshot>> {
    let snapshot = db.get_latest_snapshot().await?;
    Ok(Json(snapshot))
}

#[get("/snapshots/{ledger}")]
pub async fn get_snapshot(
    Path(ledger): Path<u32>,
    db: web::Data<Database>,
) -> Result<Json<Snapshot>> {
    let snapshot = db.get_snapshot(ledger).await?;
    Ok(Json(snapshot))
}

#[get("/status")]
pub async fn get_status(
    db: web::Data<Database>,
) -> Result<Json<StatusResponse>> {
    let state = db.get_indexer_state().await?;
    Ok(Json(StatusResponse {
        last_indexed_ledger: state.last_indexed_ledger,
        last_snapshot_ledger: state.last_snapshot_ledger,
        total_announcements: db.count_announcements().await?,
    }))
}
```

### 4. Snapshot Publisher

**Signed snapshots for verification**:

```rust
// indexer/src/snapshots.rs

pub struct SnapshotPublisher {
    signer_keypair: Keypair,
    db: Database,
}

impl SnapshotPublisher {
    /// Publish a signed snapshot at current ledger
    pub async fn publish_snapshot(&self, ledger: u32) -> Result<Snapshot> {
        // Fetch all announcements up to ledger
        let announcements = self.db.get_announcements_up_to(ledger).await?;

        // Compute data hash
        let data_hash = self.compute_data_hash(&announcements)?;

        // Sign the hash
        let signature = self.signer_keypair.sign(&data_hash)?;

        // Store snapshot
        let snapshot = Snapshot {
            ledger_sequence: ledger,
            announcement_count: announcements.len() as u32,
            data_hash: hex::encode(&data_hash),
            signature: hex::encode(&signature),
            signer_public_key: self.signer_keypair.public_key(),
            announcements,
        };

        self.db.store_snapshot(&snapshot).await?;
        Ok(snapshot)
    }

    /// Compute canonical hash of announcements
    fn compute_data_hash(&self, announcements: &[Announcement]) -> Result<[u8; 32]> {
        let mut hasher = Sha256::new();

        for ann in announcements {
            hasher.update(ann.ledger_sequence.to_be_bytes());
            hasher.update(&ann.stealth_address);
            hasher.update(&ann.ephemeral_pub_key);
            hasher.update(&ann.metadata);
        }

        Ok(hasher.finalize().into())
    }
}
```

### 5. Client Integration

**Browser client fetches from indexer**:

```typescript
// frontend/src/lib/indexerClient.ts

export class IndexerClient {
  constructor(private baseUrl: string) {}

  /// Fetch announcements with pagination
  async listAnnouncements(
    fromLedger?: number,
    limit: number = 100,
    cursor?: string,
  ): Promise<ListResponse> {
    const params = new URLSearchParams();
    if (fromLedger) params.append("from_ledger", fromLedger.toString());
    params.append("limit", limit.toString());
    if (cursor) params.append("cursor", cursor);

    const res = await fetch(`${this.baseUrl}/announcements?${params}`);
    return res.json();
  }

  /// Fetch announcements for specific stealth address
  async listByAddress(
    address: string,
    fromLedger?: number,
    limit: number = 100,
  ): Promise<ListResponse> {
    const params = new URLSearchParams();
    if (fromLedger) params.append("from_ledger", fromLedger.toString());
    params.append("limit", limit.toString());

    const res = await fetch(
      `${this.baseUrl}/announcements/by-address/${address}?${params}`,
    );
    return res.json();
  }

  /// Fetch and verify latest snapshot
  async getLatestSnapshot(): Promise<VerifiedSnapshot> {
    const res = await fetch(`${this.baseUrl}/snapshots/latest`);
    const snapshot = await res.json();

    // Verify signature
    const isValid = this.verifySnapshot(snapshot);
    if (!isValid) {
      throw new Error("Snapshot signature verification failed");
    }

    return snapshot;
  }

  /// Verify snapshot signature
  private verifySnapshot(snapshot: Snapshot): boolean {
    const { data_hash, signature, signer_public_key } = snapshot;

    // Reconstruct data hash from announcements
    const computed = this.computeDataHash(snapshot.announcements);

    // Verify signature
    return this.verifySignature(computed, signature, signer_public_key);
  }

  private computeDataHash(announcements: Announcement[]): string {
    const hasher = new Sha256();

    for (const ann of announcements) {
      hasher.update(new Uint32Array([ann.ledger_sequence]));
      hasher.update(hexToBytes(ann.stealth_address));
      hasher.update(hexToBytes(ann.ephemeral_pub_key));
      hasher.update(hexToBytes(ann.metadata));
    }

    return hasher.digest("hex");
  }
}
```

## Acceptance Criteria

### ✅ Indexer can backfill from deployment ledger

**Implementation**:

- `EventConsumer::backfill()` scans from deployment ledger to current
- Stores all announcements in database
- Resumes from last indexed ledger on restart

**Verification**:

- Start indexer at deployment ledger
- Verify all historical announcements are stored
- Check database has correct count

### ✅ API supports pagination by ledger/cursor

**Implementation**:

- `/announcements?from_ledger=1000&limit=100` - paginate by ledger
- `/announcements?cursor=abc123&limit=100` - cursor-based pagination
- `/announcements/by-address/{address}?from_ledger=1000` - filter by address

**Verification**:

- Fetch page 1: `from_ledger=1000, limit=100`
- Fetch page 2: `cursor=<last_id_from_page_1>, limit=100`
- Verify no duplicates, correct ordering

### ✅ Clients can verify response freshness or signatures

**Implementation**:

- `/status` returns `last_indexed_ledger` (freshness)
- `/snapshots/latest` returns signed snapshot
- Client verifies signature using signer public key

**Verification**:

- Fetch status, check `last_indexed_ledger` is recent
- Fetch snapshot, verify signature matches data hash
- Tamper with snapshot data, verify signature fails

## Deployment

### Docker Compose

```yaml
version: "3.8"

services:
  postgres:
    image: postgres:15
    environment:
      POSTGRES_DB: opaque_indexer
      POSTGRES_PASSWORD: password
    volumes:
      - postgres_data:/var/lib/postgresql/data

  indexer:
    build: .
    environment:
      DATABASE_URL: postgresql://postgres:password@postgres/opaque_indexer
      STELLAR_RPC_URL: https://soroban-testnet.stellar.org
      SIGNER_SECRET_KEY: ${SIGNER_SECRET_KEY}
    ports:
      - "8080:8080"
    depends_on:
      - postgres

volumes:
  postgres_data:
```

### Configuration

```toml
# indexer/config.toml

[stellar]
rpc_url = "https://soroban-testnet.stellar.org"
deployment_ledger = 1000000

[database]
url = "postgresql://postgres:password@localhost/opaque_indexer"
max_connections = 20

[api]
listen_addr = "0.0.0.0:8080"
max_page_size = 1000

[snapshots]
publish_interval_ledgers = 1000
signer_secret_key = "${SIGNER_SECRET_KEY}"
```

## Implementation Checklist

- [ ] Set up PostgreSQL schema
- [ ] Implement EventConsumer (backfill + live)
- [ ] Implement Database layer
- [ ] Implement REST API server
- [ ] Implement SnapshotPublisher
- [ ] Add client integration (IndexerClient)
- [ ] Add signature verification
- [ ] Add pagination tests
- [ ] Add backfill tests
- [ ] Deploy to testnet
- [ ] Monitor indexer lag
- [ ] Add alerting for failures

## Performance Targets

- **Backfill**: 10,000 ledgers in < 5 minutes
- **Live polling**: < 1 second latency
- **API response**: < 100ms for paginated queries
- **Snapshot generation**: < 1 second
- **Database size**: < 10GB for 1M announcements

## Security Considerations

1. **Signature Verification**: Clients verify snapshot signatures
2. **Rate Limiting**: API rate limits per IP
3. **Database Access**: Read-only replica for API
4. **Event Validation**: Verify event structure before storing
5. **Signer Key Management**: Use environment variables, rotate regularly

## References

- **Stealth Announcer Contract**: `contracts/stealth-announcer/src/lib.rs`
- **Scanner**: `scanner/src/lib.rs`
- **Frontend**: `frontend/src/lib/stealthLifecycle.ts`
- **Issuer Encoding**: `ISSUER_ENCODING.md`
- **Stealth Key Alignment**: `STEALTH_KEY_ALIGNMENT.md`
- **Trait Data Hashing**: `TRAIT_DATA_HASHING.md`
