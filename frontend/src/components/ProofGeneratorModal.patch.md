# ProofGeneratorModal.tsx Patches (Issue #920)

## Fix False Privacy Claim

Replace line ~423 with accurate disclosure:

```typescript
// OLD (FALSE):
// "No private data leaves your browser"

// NEW (ACCURATE):
<div className="text-sm text-neutral-400 mb-4 p-3 bg-neutral-900/50 rounded border border-neutral-700">
  <p className="font-semibold mb-2">Privacy Disclosure</p>
  <p className="mb-2">
    Proof generation happens locally in your browser. However, to submit the proof 
    for reputation inclusion, the following metadata is sent to the publisher service:
  </p>
  <ul className="list-disc list-inside text-xs space-y-1 mb-2">
    <li>Attestation UID (public identifier)</li>
    <li>Transaction hash (on-chain, already public)</li>
    <li>Ledger number (on-chain, already public)</li>
    <li>Schema ID (public)</li>
    <li>Merkle tree leaf hash (commitment, no raw data)</li>
  </ul>
  <p className="text-xs">
    Your private key, spending key, and attestation contents remain local and 
    are never transmitted. The publisher cannot reconstruct your private data 
    from the submitted metadata.
  </p>
</div>
```

## Minimize Publisher Payload

In the publisher submission function, reduce payload:

```typescript
// OLD (excessive):
const publisherPayload = {
  attestationUid,
  txHash,
  ledger,
  schemaId,
  leaf,
  timestamp, // NOT NEEDED
  userAgent, // NOT NEEDED
  // ... other unnecessary fields
};

// NEW (minimal):
const publisherPayload = {
  // Only what's needed for Merkle inclusion
  leaf,           // Merkle leaf commitment
  schemaId,       // Schema identifier
  // Optional: attestationUid for indexing (if required by publisher)
  attestationUid, 
};

// txHash and ledger should only be sent if publisher requires them for verification
// Remove all other fields
```

## Update Landing Page Claims

If landing page has privacy claims, update with:

```typescript
// Replace:
// "No server round-trips"

// With:
"Proof generation is fully local. Submitting proofs requires minimal metadata 
(Merkle leaf, schema ID) to be sent to the reputation publisher."
```

## Document Real Data Flow

Create or update `docs/PRIVACY_GUARANTEES.md`:

```markdown
# Privacy Guarantees

## What Stays Local
- Private spending key (never leaves device)
- Attestation raw content (never transmitted)
- Proof witness data (used only in browser)

## What Is Transmitted
When you submit a proof for reputation inclusion:

1. **Merkle Leaf Hash** - A cryptographic commitment, not your raw data
2. **Schema ID** - Public attestation schema identifier
3. **Attestation UID** (optional) - Public identifier for indexing

## What Is NOT Transmitted
- Your private key
- Your spending key  
- Attestation content
- Any personally identifiable information

## Publisher Service
The reputation publisher receives only the minimal data needed to include 
your proof in the Merkle tree. It cannot reconstruct your private data 
from the submitted metadata.

## On-Chain Data
Transaction hashes and ledger numbers are already public on the Stellar 
blockchain. We may reference them for verification, but they do not 
constitute new data disclosure.
```
