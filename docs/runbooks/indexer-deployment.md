# Indexer deployment runbook

Running a production indexer for Opaque requires careful configuration of hardware, environment variables, and monitoring. This runbook covers Docker and bare-metal deployments, version compatibility with the scanner, backfill procedures, and upgrade/rollback steps.

---

## Hardware requirements

### Bare-metal

- **CPU**: 4+ cores, 3.0 GHz+ (Intel/AMD x64)
- **Memory**: 16 GB minimum, 32 GB recommended
- **Storage**: NVMe SSD, 500 GB minimum (depends on state size and backfill depth)
- **Network**: 100 Mbps+ sustained, <100ms latency to Stellar RPC endpoint
- **OS**: Linux 5.10+ (Ubuntu 20.04 LTS or later recommended)

### Docker (containerized)

- **Host**: Same bare-metal specs above
- **Container runtime**: Docker 20.10+ or containerd 1.5+
- **Storage volume**: Persistent volume mounted at `/data/indexer` with 500 GB+ capacity
- **Memory limit**: 12 GB (reserve 4 GB for OS and other containers)
- **CPU limit**: 3 cores (leave 1 core for OS)

---

## Environment variables

Copy `.env.example` to `.env` and configure:

```bash
# Stellar network configuration
STELLAR_NETWORK=testnet                 # or mainnet
STELLAR_RPC_URL=https://soroban-testnet.stellar.org
STELLAR_HORIZON_URL=https://horizon-testnet.stellar.org

# Indexer behavior
INDEXER_START_LEDGER=0                  # 0 = from genesis, or specify a ledger number
INDEXER_BATCH_SIZE=100                  # events per batch (increase for faster backfill)
INDEXER_POLL_INTERVAL_MS=5000           # polling interval in milliseconds
INDEXER_WORKER_THREADS=4                # match CPU core count

# Storage
INDEXER_DB_PATH=/data/indexer           # persistent storage location
INDEXER_DB_CHECKPOINT_INTERVAL=1000     # checkpoint every N ledgers

# Logging
INDEXER_LOG_LEVEL=info                  # debug, info, warn, error
INDEXER_LOG_DIR=/var/log/indexer        # log file directory
INDEXER_LOG_RETENTION_DAYS=30           # retain logs for N days

# Monitoring
INDEXER_METRICS_PORT=8081               # Prometheus metrics endpoint
INDEXER_HEALTH_CHECK_PORT=8082          # liveness/readiness probe endpoint
INDEXER_ALERT_WEBHOOK=                  # optional Slack/PagerDuty webhook for errors
```

---

## Bare-metal installation

### 1. Prerequisites

```bash
# Rust toolchain (or use pre-built binary)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source $HOME/.cargo/env

# Build indexer from source
git clone https://github.com/collinsadi/opauque-stellar.git
cd opauque-stellar/indexer
cargo build --release
```

Or download a pre-built binary from [releases](https://github.com/collinsadi/opauque-stellar/releases).

### 2. Create a dedicated user

```bash
sudo useradd -m -s /bin/bash indexer
sudo mkdir -p /data/indexer /var/log/indexer
sudo chown -R indexer:indexer /data/indexer /var/log/indexer
sudo chmod 750 /data/indexer /var/log/indexer
```

### 3. Install and configure

```bash
sudo cp target/release/indexer /usr/local/bin/opaque-indexer
sudo chmod 755 /usr/local/bin/opaque-indexer

# Copy .env to /etc/opaque/indexer.env
sudo mkdir -p /etc/opaque
sudo cp .env.example /etc/opaque/indexer.env
sudo chown root:root /etc/opaque/indexer.env
sudo chmod 600 /etc/opaque/indexer.env

# Edit for your network and hardware
sudo vi /etc/opaque/indexer.env
```

### 4. Create systemd service

Save as `/etc/systemd/system/opaque-indexer.service`:

```ini
[Unit]
Description=Opaque Stellar Indexer
Documentation=https://github.com/collinsadi/opauque-stellar/docs/runbooks/indexer-deployment.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=indexer
Group=indexer
WorkingDirectory=/data/indexer

EnvironmentFile=/etc/opaque/indexer.env
ExecStart=/usr/local/bin/opaque-indexer

Restart=on-failure
RestartSec=30
StandardOutput=journal
StandardError=journal
SyslogIdentifier=opaque-indexer

# Resource limits
MemoryLimit=12G
CPUQuota=300%

# Security hardening
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes

[Install]
WantedBy=multi-user.target
```

Then enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable opaque-indexer
sudo systemctl start opaque-indexer
sudo systemctl status opaque-indexer
```

### 5. Verify operation

```bash
# Check logs
sudo journalctl -u opaque-indexer -f

# Query metrics endpoint
curl http://localhost:8081/metrics

# Health check
curl http://localhost:8082/ready
```

---

## Docker deployment

### 1. Build Docker image

```bash
docker build -f Dockerfile.indexer \
  --build-arg STELLAR_NETWORK=testnet \
  -t opaque-indexer:latest .
```

Or use a pre-built image from [ghcr.io/collinsadi/opaque-indexer](https://ghcr.io/collinsadi/opaque-indexer).

### 2. Create persistent volume

```bash
docker volume create opaque-indexer-data
```

### 3. Run container

```bash
docker run -d \
  --name opaque-indexer \
  --restart unless-stopped \
  -v opaque-indexer-data:/data/indexer \
  -v opaque-indexer-logs:/var/log/indexer \
  -e STELLAR_NETWORK=testnet \
  -e STELLAR_RPC_URL=https://soroban-testnet.stellar.org \
  -e INDEXER_WORKER_THREADS=3 \
  -e INDEXER_LOG_LEVEL=info \
  -p 8081:8081 \
  -p 8082:8082 \
  -m 12g \
  --cpus="3" \
  opaque-indexer:latest
```

### 4. Verify operation

```bash
docker logs -f opaque-indexer
curl http://localhost:8081/metrics
curl http://localhost:8082/ready
```

### 5. Docker Compose (optional)

Save as `docker-compose.indexer.yml`:

```yaml
version: '3.8'

services:
  indexer:
    image: opaque-indexer:latest
    container_name: opaque-indexer
    restart: unless-stopped
    
    volumes:
      - opaque-indexer-data:/data/indexer
      - opaque-indexer-logs:/var/log/indexer
    
    environment:
      STELLAR_NETWORK: testnet
      STELLAR_RPC_URL: https://soroban-testnet.stellar.org
      INDEXER_WORKER_THREADS: 3
      INDEXER_LOG_LEVEL: info
    
    ports:
      - "8081:8081"
      - "8082:8082"
    
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8082/ready"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 60s
    
    deploy:
      resources:
        limits:
          cpus: '3'
          memory: 12G
        reservations:
          memory: 8G

volumes:
  opaque-indexer-data:
  opaque-indexer-logs:
```

Then:

```bash
docker-compose -f docker-compose.indexer.yml up -d
```

---

## Initial backfill

First time setup requires indexing all historical events from the network. This can take hours to days depending on network age.

### 1. Start backfill

```bash
# Set INDEXER_START_LEDGER=0 in .env to backfill from genesis
# Increase INDEXER_BATCH_SIZE=500 for faster throughput (if hardware allows)
# Use INDEXER_WORKER_THREADS=8 or higher for parallel processing

systemctl restart opaque-indexer
# or: docker restart opaque-indexer
```

### 2. Monitor progress

```bash
# Watch the logs for ledger advancement
journalctl -u opaque-indexer -f | grep "ledger"

# Query metrics endpoint to track throughput
curl http://localhost:8081/metrics | grep indexer_ledger

# Expected rate: 100-500 ledgers/second depending on hardware and batch size
```

### 3. Cancel and resume

If backfill is interrupted (network issue, hardware failure):

```bash
# Stop the indexer
systemctl stop opaque-indexer

# The last checkpoint is preserved. Restart to resume from that point
systemctl start opaque-indexer

# Verify ledger continuity in the logs
journalctl -u opaque-indexer -n 50
```

---

## Version compatibility with scanner

The scanner reads events emitted by the indexer. Event schema versions must match.

### Check versions

```bash
# Get indexer event schema version from deployment manifest
cat deployments/v1/testnet.json | jq '.contracts.indexer.eventVersion'

# Get scanner compatibility matrix from release notes
curl https://api.github.com/repos/collinsadi/opauque-stellar/releases/latest | jq '.body'
```

### Supported compatibility

| Indexer version | Event schema | Scanner compatibility | Notes |
|---|---|---|---|
| v1.0.0 | v1 | v1.0.0+ | Initial release |
| v1.1.0 | v1 | v1.0.0-1.1.0 | Backwards compatible |
| v1.2.0 | v2 | v1.2.0+ | Breaking change, requires scanner upgrade |

**Rule**: Always upgrade the scanner to at least the minimum compatible version before upgrading the indexer event schema.

### Before upgrading

1. Verify the deployment manifest event version matches your running indexer.
2. Confirm all connected scanners can handle the new event schema.
3. Plan the upgrade during a maintenance window.

---

## Upgrades

### Bare-metal upgrade

```bash
# Build or download the new version
cargo build --release
# or: curl -L https://github.com/collinsadi/opauque-stellar/releases/download/v1.2.0/indexer-linux-x64 -o /tmp/indexer

# Stop the indexer
sudo systemctl stop opaque-indexer

# Backup the database
sudo cp -a /data/indexer /data/indexer.backup.$(date +%s)

# Replace the binary
sudo cp target/release/indexer /usr/local/bin/opaque-indexer
# or: sudo cp /tmp/indexer /usr/local/bin/opaque-indexer

# Start the new version
sudo systemctl start opaque-indexer

# Verify
sudo journalctl -u opaque-indexer -n 20
curl http://localhost:8082/ready
```

### Docker upgrade

```bash
# Pull the new image
docker pull opaque-indexer:v1.2.0

# Backup the volume
docker run --rm -v opaque-indexer-data:/data -v /tmp:/backup alpine tar czf /backup/indexer.backup.tar.gz /data

# Stop and remove the old container
docker stop opaque-indexer
docker rm opaque-indexer

# Start the new version
docker run -d \
  --name opaque-indexer \
  --restart unless-stopped \
  -v opaque-indexer-data:/data/indexer \
  -e STELLAR_NETWORK=testnet \
  -p 8081:8081 \
  -p 8082:8082 \
  opaque-indexer:v1.2.0

# Verify
docker logs -f opaque-indexer
curl http://localhost:8082/ready
```

---

## Rollback

If the upgraded version breaks indexing:

### Bare-metal rollback

```bash
# Stop the indexer
sudo systemctl stop opaque-indexer

# Restore the backup database (if state corruption occurred)
sudo rm -rf /data/indexer
sudo cp -a /data/indexer.backup.<timestamp> /data/indexer
sudo chown -R indexer:indexer /data/indexer

# Restore the binary
sudo cp /usr/local/bin/opaque-indexer.old /usr/local/bin/opaque-indexer

# Restart
sudo systemctl start opaque-indexer
sudo journalctl -u opaque-indexer -n 20
```

### Docker rollback

```bash
# Backup the corrupted volume (for debugging)
docker run --rm -v opaque-indexer-data:/data -v /tmp:/backup alpine tar czf /backup/indexer.corrupted.tar.gz /data

# Restore the volume backup
docker run --rm -v opaque-indexer-data:/data -v /tmp:/backup alpine tar xzf /backup/indexer.backup.tar.gz -C /

# Restart with the previous image
docker stop opaque-indexer
docker rm opaque-indexer
docker run -d --name opaque-indexer opaque-indexer:v1.1.0 ...
```

---

## Monitoring and alerting

### Prometheus metrics

The indexer exposes Prometheus metrics on port 8081:

```
indexer_ledger_number{network="testnet"}
indexer_events_processed_total{network="testnet"}
indexer_checkpoint_duration_seconds
indexer_rpc_latency_seconds
indexer_error_count{error_type="connection"}
```

### Configure Prometheus scrape

```yaml
- job_name: 'opaque-indexer'
  static_configs:
    - targets: ['localhost:8081']
  scrape_interval: 30s
```

### Key alerts

Create these alerts in Prometheus/Alertmanager:

```yaml
# Indexer fell behind (not processing new ledgers for 5 minutes)
alert: IndexerLagging
expr: increase(indexer_ledger_number[5m]) == 0
duration: 5m
action: Page on-call engineer

# RPC endpoint unavailable (3 consecutive scrape failures)
alert: IndexerRPCError
expr: increase(indexer_error_count{error_type="connection"}[1m]) > 5
duration: 3m
action: Check RPC endpoint health, failover if configured

# Database corruption detected
alert: IndexerCheckpointFailure
expr: increase(indexer_error_count{error_type="checkpoint"}[1m]) > 0
duration: 1m
action: Stop indexer, restore from backup, page on-call
```

### Health check endpoints

- `GET /ready` - Returns 200 if indexer is operational and caught up (within last 10 ledgers)
- `GET /alive` - Returns 200 if the process is running (use for docker healthcheck)

---

## Troubleshooting

### Indexer crashes on startup

Check the logs for the specific error:

```bash
journalctl -u opaque-indexer -n 100
```

Common causes:
- **Corrupted database**: Restore from a backup or delete `/data/indexer/state.db` to resync
- **Permission denied**: Verify user `indexer` owns `/data/indexer`
- **Port already in use**: Check if another indexer is running or adjust `INDEXER_METRICS_PORT`

### Indexer falls behind (lagging)

If the indexer stops advancing ledgers:

```bash
# 1. Check RPC connectivity
curl -s $STELLAR_RPC_URL/getLatestLedger | jq .

# 2. Monitor CPU and memory
top -u indexer

# 3. Check log tail for repeated errors
journalctl -u opaque-indexer -f
```

Solutions:
- Increase `INDEXER_WORKER_THREADS` and `INDEXER_BATCH_SIZE`
- Scale hardware (more CPU/RAM)
- Switch RPC endpoint (set `STELLAR_RPC_URL` to a fallback)

### Events not being indexed

Verify the contract addresses in the manifest match what the indexer expects:

```bash
# Get the expected contract from the manifest
cat deployments/v1/testnet.json | jq '.contracts.indexer.address'

# Verify the indexer is watching that contract
journalctl -u opaque-indexer | grep "watching contract"
```

If contracts don't match, the deployment manifest or `.env` is out of sync.

---

## Maintenance

### Database compaction

Over time, the database may accumulate tombstones. Compact it during a maintenance window:

```bash
# Stop the indexer
systemctl stop opaque-indexer

# Compact
/usr/local/bin/opaque-indexer --db-compact /data/indexer

# Restart
systemctl start opaque-indexer
```

### Log rotation

Configure logrotate to clean old logs:

Save as `/etc/logrotate.d/opaque-indexer`:

```
/var/log/indexer/*.log {
  daily
  rotate 30
  missingok
  notifempty
  compress
  postrotate
    systemctl reload opaque-indexer > /dev/null 2>&1 || true
  endscript
}
```

---

## References

- [Deployment manifest format](../deployments/README.md)
- [Stellar RPC API docs](https://developers.stellar.org/docs/build/smart-contracts/serve-traffic-soroban-rpc)
- [Indexer source code](../../scanner/src/indexer.rs)
