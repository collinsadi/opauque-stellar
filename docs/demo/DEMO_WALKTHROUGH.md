# Demo Walkthrough: Opaque Stellar Privacy in Action

**Runtime**: 4-5 minutes  
**Target audience**: Hackathon attendees, privacy-conscious developers, Stellar ecosystem  
**Key message**: Private payments and provable reputation without wallet exposure

---

## Opening (15 seconds)

### Narration

"Imagine sending crypto without your account ever appearing on a public ledger. Or proving you're verified—without revealing your identity. That's Opaque Stellar."

**Visual**: Show a blockchain explorer with a typical wallet receiving transactions, then show the same with all transactions hidden/blurred. Transition to a clean Opaque wallet UI.

---

## Section 1: Stealth Payments (60 seconds)

### Narration

"First, stealth payments. When you're the recipient of money in traditional crypto, your public address is linked to every transaction. Not here."

**Onscreen demo**:
1. Open Opaque wallet UI (show testnet connection)
2. Click "Generate stealth address" (shows "Stealth address ready")
3. Send someone your stealth address via chat or email
4. Recipient opens their wallet and sends you XLM to that address
5. Show the transaction appearing on a Stellar blockchain explorer:
   - Sender public address is visible
   - Recipient address is a one-time stealth address (new, random)
   - No link between your receive address and your main wallet
6. In your wallet, show the payment arriving in "Incoming"
7. Click "Sweep to main wallet" (moves funds to your primary account)
8. Show a transaction that proves you know the key to both addresses (zero-knowledge)

### Narration (continued)

"The sender broadcasts to a stealth address, visible on-chain. But only you can derive the spending key. Once you sweep it to your main wallet, the blockchain proves you own both addresses—without revealing your identity. No one watching the chain can link them without access to your keys."

**Privacy guarantee to highlight**: Only the sender, recipient, and anyone who knows your private key can link the stealth address to you.

---

## Section 2: Proving Reputation (90 seconds)

### Narration

"Now, reputation. Maybe you're a trusted trader, or verified by a KYC provider. Opaque lets you prove it without revealing who you are."

**Onscreen demo**:
1. Show "Attestations" tab in wallet (display 2-3 sample attestations)
   - "Verified KYC - Issued by TrustVerifier"
   - "10+ Successful Transactions - Issued by Reputation Oracle"
   - "Holds 100+ XLM - Self-attested"
2. Explain: "These attestations are encrypted on-chain. Only your wallet can decrypt them."
3. Click on an attestation to show details (issuer signature, issuance date)
4. Open a demo application (a hypothetical DeFi app or marketplace)
5. The app shows: "Verify reputation to continue"
6. Click "Generate proof" in the Opaque wallet
7. Show proof generation in progress (animation of circuit, ~5-10 seconds)
8. Once complete, show a summary: "Proving: I hold 10+ successful transactions AND 100+ XLM"
9. Show the proof being sent to the application
10. The app verifies and displays: "Verified ✓ You are eligible"
11. Show the user's transaction logged on-chain (a nullifier hash, not an identity)

### Narration (continued)

"The application never sees your identity. It only verifies that you meet the criteria, using a mathematical proof. The proof is locked to this specific application and timestamp—it can't be reused elsewhere. On-chain, only a nullifier hash appears. No one can link it to you or your account without your private key."

**Privacy guarantee to highlight**: 
- Application sees no personal data
- Proof cannot be reused
- On-chain record is unlinkable to your identity

---

## Section 3: Privacy in Practice (60 seconds)

### Narration

"Let's talk about what's actually visible."

**Onscreen visual** (split screen or comparison table):

**On-chain visibility (what observers see)**:
- Stealth address receives XLM from a sender
- Sweep transaction proves knowledge of the stealth key
- Proof verification generates a nullifier (hash)
- Application processes the nullifier
- No public addresses. No identities. No personal data.

**User visibility (what only you see)**:
- Your main wallet address (private)
- Your private keys and stealth keys (encrypted local storage)
- Attestations (decrypted by your wallet)
- Full proof history

**Application visibility (what the app sees)**:
- Proof is valid
- Nullifier (prevents reuse)
- Public inputs (time window, application ID, optional metadata)
- No account info. No balance. No transaction history.

### Narration (continued)

"The privacy guarantee is strong: even if the application, an observer, and a blockchain node collude, they still can't identify you. The only information linking proofs to users is the nullifier—which requires your private key to generate. Opaque ensures your wallet exposure stays zero."

---

## Section 4: Use Cases (45 seconds)

### Narration

"Where does this matter?"

**Onscreen scenarios** (brief screenshots or mockups):

1. **DeFi**: "Prove you're a verified trader without revealing your funds or trading volume"
2. **Reputation networks**: "Prove you have a trusted identity without linking all your accounts"
3. **Employment/DAO verification**: "Prove membership or contribution history to a DAO without revealing your address"
4. **Privacy-first commerce**: "Make purchases without your wallet history being public"
5. **Compliance**: "Prove you passed KYC without your identity being stored by the application"

### Narration (continued)

"All of these work while preserving your privacy. Opaque is open-source, auditable, and designed for production use."

---

## Closing (30 seconds)

### Narration

"Opaque Stellar is built on Soroban smart contracts and the Stellar consensus network. Proofs are verified on-chain, so you don't have to trust a centralized service. Try it now at [frontend-url]."

**Onscreen**:
- Show GitHub repository link: https://github.com/collinsadi/opauque-stellar
- Show wallet link: https://opaque-stellar-wallet.example.com (or localhost:5173)
- Show key highlights:
  - "Open source"
  - "Zero wallet exposure"
  - "Cryptographically proven"
  - "Built on Stellar + Soroban"

### Final frame

Opaque Stellar logo + tagline: **"Private payments. Provable reputation. Zero wallet exposure."**

---

## Technical Details for Narration (Reference)

Include these points naturally if time allows:

- **DKSAP stealth addresses**: One-time accounts derived using elliptic curve math; only the recipient can spend
- **Groth16 proofs**: Zero-knowledge proofs verified on-chain by Soroban contracts
- **Nullifiers**: Prevent proof reuse while maintaining privacy (attacker cannot link nullifiers to accounts)
- **Event schema**: Applications define proof requirements; Opaque verifies them on-chain
- **Scanner WASM**: Browser-based Rust code that finds stealth addresses and generates proofs client-side

---

## Demo Checklist

Before recording:

- [ ] Wallet is connected to testnet
- [ ] Testnet account has ~1 XLM for demo transactions
- [ ] Stealth keys are initialized
- [ ] Sample attestations are loaded (or use realistic mock data)
- [ ] Demo application is running locally or accessible
- [ ] Proof generation takes ~5-10 seconds (acceptable for demo)
- [ ] Screenshots/mockups of use cases are prepared
- [ ] Slides with key privacy guarantees are ready
- [ ] Audio is clear and narration is timed for 4-5 minutes total

---

## Alternative Short Format (2 minutes)

If a shorter demo is needed for lightning talks:

1. **Opening** (20s): "Stealth addresses + zero-knowledge proofs = private crypto"
2. **Send** (30s): Send to stealth address, show it arriving, sweep it
3. **Prove** (50s): Show attestation, generate proof, verify on application
4. **Closing** (20s): Highlight privacy guarantees and GitHub link

---

## For Video Editing

- Add visual overlays for key terms (stealth address, proof, nullifier)
- Highlight privacy-preserving steps in green, risky steps in red (none in this demo)
- Use screen recording with ~1.2x or 1.5x speed for demo interactions
- Fade between sections with brief title cards:
  - "Stealth Payments"
  - "Reputation Proofs"
  - "What's Visible?"
  - "Real-World Use Cases"
  - "Get Started"
- Background music: Ambient, minimal (no distracting sound effects)
- Final seconds: Upbeat close with logo animation

---

## Accessibility Notes

- Captions: Include full narration as captions for accessibility
- Color contrast: Ensure demo UI is readable in screenshots
- Pace: Speak clearly, pause between sections for viewers to absorb
- Text size: Make wallet UI large enough to read on small screens

---

**Version**: 1.0  
**Last updated**: June 2024  
**Estimated production time**: 30-45 minutes (including takes and editing)
