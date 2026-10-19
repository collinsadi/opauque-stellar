# Privacy Guarantees (Issue #920)

## What Stays Local
- **Private spending key** - Never leaves your device
- **Attestation raw content** - Never transmitted  
- **Proof witness data** - Used only in browser for ZK proof generation

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

The reputation publisher receives only the minimal data needed to include your proof in the Merkle tree. It **cannot reconstruct your private data** from the submitted metadata.

## On-Chain Data

Transaction hashes and ledger numbers are already public on the Stellar blockchain. We may reference them for verification, but they do not constitute new data disclosure.

## Proof Generation

Zero-knowledge proofs are generated entirely locally in your browser using WebAssembly. The proof computation never sends intermediate witness data to any server.

## Claim Destinations and Identity Linkage

Withdrawing a stealth balance to your connected (main) wallet links the
one-time stealth address to your public identity. The UI no longer offers a
one-click shortcut that fills the claim destination with the connected
wallet. Choosing that destination now requires explicitly acknowledging the
linkage in a checkbox before the option becomes available. Prefer a fresh
address when privacy matters.

## Transparency

We are transparent about what data leaves your browser. If you find any privacy claim that is inaccurate, please report it as a security issue.
