# poolProver.ts Patches (Issue #921)

## Add Indexer Fallback for Old Deposits

Add at top of file:

```typescript
// Indexer fallback configuration
const INDEXER_CONFIG = {
  enabled: true,
  endpoint: process.env.VITE_INDEXER_URL || 'https://indexer.opaque.network/api',
  maxRetries: 2,
};

interface IndexerDeposit {
  ledger: number;
  txHash: string;
  leaf: Uint8Array;
  timestamp: number;
}

/**
 * Fetch deposits from indexer for events beyond RPC retention
 */
async function fetchFromIndexer(
  poolAddress: string,
  fromLedger: number,
  toLedger: number
): Promise<IndexerDeposit[]> {
  if (!INDEXER_CONFIG.enabled) {
    throw new Error('Indexer fallback is disabled');
  }

  const url = `${INDEXER_CONFIG.endpoint}/deposits?pool=${poolAddress}&from=${fromLedger}&to=${toLedger}`;
  
  for (let attempt = 0; attempt < INDEXER_CONFIG.maxRetries; attempt++) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Indexer HTTP ${response.status}`);
      }
      
      const data = await response.json();
      return data.deposits.map((d: any) => ({
        ledger: d.ledger,
        txHash: d.txHash,
        leaf: hexToBytes(d.leaf),
        timestamp: d.timestamp,
      }));
    } catch (error) {
      if (attempt === INDEXER_CONFIG.maxRetries - 1) throw error;
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  
  return [];
}
```

## Detect Page Cap Truncation

Modify the event fetching loop:

```typescript
// Inside rebuildTreeFromEvents(), after the page loop:

// Detect if page cap was hit
const PAGE_CAP = 200;
if (pageCount >= PAGE_CAP) {
  console.warn(`⚠️  Event fetch hit ${PAGE_CAP}-page cap. Tree may be incomplete.`);
  
  // Try indexer fallback for old events
  if (INDEXER_CONFIG.enabled && oldestLedger) {
    try {
      console.log('Attempting indexer fallback for events beyond RPC retention...');
      const indexerDeposits = await fetchFromIndexer(
        poolAddress,
        oldestLedger,
        oldestLedger + 16_000
      );
      
      if (indexerDeposits.length > 0) {
        console.log(`✓ Fetched ${indexerDeposits.length} deposits from indexer`);
        // Prepend to leaves array
        allLeaves = [
          ...indexerDeposits.map(d => d.leaf),
          ...allLeaves,
        ];
      }
    } catch (indexerError) {
      console.error('Indexer fallback failed:', indexerError);
      throw new Error(
        `Event fetch truncated at ${PAGE_CAP} pages and indexer fallback failed. ` +
        `Tree reconstruction may be incomplete. Some old notes may be unprovable.`
      );
    }
  } else {
    throw new Error(
      `Event fetch truncated at ${PAGE_CAP} pages. ` +
      `Notes older than RPC retention may be unprovable. ` +
      `Enable indexer fallback for complete tree reconstruction.`
    );
  }
}
```

## Testing

Add test case:

```typescript
describe('poolProver beyond retention', () => {
  it('uses indexer fallback when RPC events are truncated', async () => {
    // Mock RPC returning 200 pages (cap hit)
    // Mock indexer returning old deposits
    // Verify tree includes indexer deposits
  });

  it('throws clear error when page cap hit and no indexer', async () => {
    // Disable indexer
    // Mock 200 pages from RPC
    // Expect error with actionable message
  });
});
```
