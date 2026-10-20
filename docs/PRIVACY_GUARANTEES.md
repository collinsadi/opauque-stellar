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

## History Sync (Horizon)

Transaction history is stored locally. Rebuilding it from chain sends a query to
Horizon. It runs only in two cases:

- **You click "Sync from chain"** in the History view.
- **You opt in** with "Rebuild history from chain automatically on this device".
  The choice is saved on this device only. It is off by default, so a fresh or
  cleared device does not query Horizon until you choose to.

A sync queries Horizon for the connected wallet's payments and account
creations, and for the ghost addresses owned by that same account. Each address
is queried separately, so a ghost is never queried alongside another account's
wallet. Horizon operators can see those addresses, the request timing, and the
IP address that made the request. A ghost is attributed to an account only when
it was created while that account was connected. Ghosts created before this
attribution existed have no owner, so no sync sends them to Horizon. Their
balances still show locally.

## Ghost Announcer Funding

Publishing a ghost announcement uses a one-time announcer account derived from
the ghost's ephemeral key. The announcer is funded from the ghost's own balance,
never from the connected wallet, so the main wallet does not appear next to the
announcement. After the announcement is confirmed, the announcer's leftover
reserve is merged back into the ghost. What Horizon and the network can see:
the transfer from the ghost to its announcer, the announcement, and the reserve
return. None of these link the connected wallet.

## Transparency

We are transparent about what data leaves your browser. If you find any privacy claim that is inaccurate, please report it as a security issue.
