# FAQ: Reputation Proofs in Opaque Stellar

This document answers the most common questions about reputation proofs, nullifiers, traits, attestations, and privacy guarantees in Opaque Stellar.

---

## Understanding Reputation Proofs

### What is a reputation proof?

A reputation proof is a zero-knowledge proof that demonstrates you satisfy certain eligibility criteria (called traits) without revealing your identity or linking the proof to your public Stellar address.

**Example**: You can prove "I have completed 10+ successful transactions" without disclosing your account number, transaction history, or any identifying information.

### What is a trait?

A trait is a criteria or condition you can prove about yourself. Traits are defined by the protocol and verified on-chain.

**Common traits**:
- Transaction count (completed N+ transactions)
- Account age (exists for N+ days)
- Balance threshold (holds N+ XLM)
- Attestation presence (holds attestations from specific issuers)
- Custom application-defined traits (via schema smart contracts)

### What is an attestation?

An attestation is a signed claim issued by a trusted party (attestor) that confirms a trait about your account. It is stored on-chain in the Opaque registry.

**Example**: A KYC provider issues an attestation saying "account X is verified for identity."

Attestations are not linked to your public Stellar address. They are stored encrypted under a commitment, so only the account that issued the attestation can decrypt it.

---

## Proof Mechanics

### How do I create a proof?

1. **Scan for attestations**: Your local wallet WASM scanner searches all on-chain announcements for attestations issued to your stealth keys
2. **Generate proof**: The scanner verifies attestation signatures and generates a Groth16 zero-knowledge proof
3. **Submit proof**: You send the proof to an application or service
4. **Verify on-chain**: The application calls an Opaque smart contract to verify the proof

All computation happens locally in the browser or app. Your private keys never leave your device.

### Can I reuse the same proof?

**No.** Each proof is tied to a specific use case (determined by the application's nonce and schema). Reusing a proof is detected on-chain and rejected.

**Why?** Proof linkability is a known privacy leak. If the same proof can be verified twice, an observer who monitors the verifier contract can link both uses to the same user.

### What if I want to prove the same trait to multiple applications?

Generate a fresh proof for each application. The proofs will be cryptographically different even though they prove the same underlying fact. This unlinking is a core privacy feature.

---

## Nullifiers

### What is a nullifier?

A nullifier is a deterministic hash of your private key and the proof you generated. It is revealed on-chain during proof verification.

**Purpose**: Prevent proof reuse. If someone tries to verify the same proof twice, the on-chain contract detects the duplicate nullifier and rejects it.

### Why reveal nullifiers if I want privacy?

**Tradeoff**: Nullifiers are necessary to prevent proof reuse attacks. The privacy cost is minimal:

- The nullifier is a hash, so it does not leak your private key
- An observer cannot link the nullifier to your account without your private key
- An observer cannot link multiple nullifiers to the same user (without collusion)

### Can someone track me using nullifiers?

**Only if they control the verifier smart contract.** If you submit a proof to an application and that application is colluding with an observer:

1. The application reveals the proof to the observer
2. The observer recomputes your nullifier (knowing your proof)
3. The observer watches the verifier contract for that nullifier

This is application-level tracking, not a leak in Opaque's protocol.

**Mitigation**: Only submit proofs to applications you trust.

---

## What Gets Revealed On-Chain

### During proof verification, the verifier contract sees:

1. **The nullifier** - A deterministic hash, unique per proof (required to prevent reuse)
2. **The proof itself** - The Groth16 proof object (needed to verify it)
3. **Public inputs to the proof** - These depend on the application's schema:
   - Often: an application-chosen nonce or identifier (to prevent replay across applications)
   - Rarely: output values if the application needs them (e.g., "proof was generated in the last 24 hours")

### What is NOT revealed:

- Your private key
- Your account address
- Your stealth key
- Individual attestations you hold
- Your identity or personal data
- Which traits you used to construct the proof

### Can an observer correlate me across verifications?

**Only if the application chooses to reveal a user identifier in the public inputs.**

Example (bad design):
```
Proof public inputs: {
  nonce: "app-login-2024-01",
  user_id: "alice@example.com"  // LINKED!
}
```

Example (good design):
```
Proof public inputs: {
  nonce: "app-login-2024-01",
  user_commitment: "hash(alice's public key)"  // Anonymous, per-app
}
```

Opaque's design is neutral - privacy depends on the application's schema choices.

---

## Proof Limits and Constraints

### How many traits can I prove in one proof?

This depends on the circuit design and the application's schema:

- **Standard proofs**: 1 to 3 traits per proof (recommended)
- **Complex proofs**: 5-10 traits possible, but proof generation time increases ~linearly
- **Practical limit**: Circuit constraint count grows with trait complexity; larger proofs are slower and fail if they exceed Groth16's built-in limits

**Recommendation**: Design application schemas with minimal required traits. Larger proofs are slower to generate on-device and take longer to verify on-chain.

### What if I don't meet a trait requirement?

The proof will fail to generate. You cannot create a valid zero-knowledge proof for a trait you don't satisfy.

**Options**:
1. Acquire the missing attestation (e.g., undergo KYC)
2. Wait for a time-based trait to be satisfied (e.g., 30-day account age)
3. Accumulate transactions if a transaction count trait is required

### How long is a proof valid?

**By default**: Indefinitely. A proof does not expire.

**With time constraints**: The application's schema can include a time-window constraint (e.g., "prove you have a balance, as of the last 24 hours").

---

## Privacy Guarantees

### Can Opaque track me?

**No.** Opaque has no infrastructure to track users. Privacy does not depend on trusting Opaque Labs:

1. All computation happens on your device (browser or app)
2. Proofs are verified on-chain by open-source smart contracts
3. Attestations are encrypted client-side; servers cannot decrypt them
4. Your private keys and stealth keys never leave your device

### What about the applications I submit proofs to?

Applications can track you if you use an identifier in the proof. This is orthogonal to Opaque's privacy - it's a schema design issue.

**Best practice for applications**:
- Use random nonces or time-based identifiers
- Do not include user identifiers in proof public inputs
- Separate the proof verification step from the user login step

### What if an attestor is malicious?

If an attestor issues false attestations:

1. You can prove the attestation came from that issuer (it's signed)
2. The attestor is responsible for the claim, not Opaque
3. Applications can revoke trust in a malicious attestor's key

Opaque does not validate attestation content - it only verifies signatures. Attestation truth is the responsibility of issuers and application designs.

### Am I safe from quantum computers?

**Not yet.** Opaque uses ECDSA signatures (elliptic curve) and SHA-256 hashing, which are vulnerable to quantum computers. Groth16 proofs are also at risk.

**Planned**: Post-quantum signatures and circuits are being researched. Current code is not quantum-resistant.

---

## Troubleshooting

### I see "proof generation failed" error

Common causes:

1. **Missing attestation**: You don't hold an attestation required by the application's schema
   - *Fix*: Request an attestation from the issuer before retrying

2. **Outdated scanner**: Your browser's scanner WASM is out of sync with the contract
   - *Fix*: Hard-refresh the wallet page (Ctrl+Shift+R or Cmd+Shift+R)

3. **Circuit mismatch**: The application's circuit no longer matches the one in your browser
   - *Fix*: Check the application's documentation for a supported version

4. **Key derivation issue**: Your stealth key configuration is incorrect
   - *Fix*: Re-initialize stealth keys in wallet settings

### My nullifier appears in transaction history but I don't recognize the application

This can happen if:

1. An application verified your proof without your consent (escalate to the application)
2. Someone submitted a proof on your behalf (unlikely if you control your keys)
3. You previously used the application and forgot

**Action**: Audit your proof submissions. Review the application's privacy policy.

### Can an application force me to prove something I don't want to?

**No.** Proof generation is entirely client-side:

1. An application can *request* a proof (ask you to click "verify reputation")
2. You must initiate proof generation in your wallet
3. You can cancel at any time
4. The application never sees your private key or intermediate computation

---

## Application Design

### How should I design a schema with good privacy?

1. **Minimize required traits**: Each trait increases proof size and generation time
2. **Avoid user identifiers in public inputs**: Use nonces or commitments instead
3. **Design for revocation**: Allow users to revoke attestations they no longer want to claim
4. **Be transparent**: Document what is revealed in proofs and why
5. **Assume proofs might be observed**: Design schemas that don't leak via nullifier analysis

### Should I store proofs my application receives?

**No**, unless you have a specific compliance reason. If you store proofs:

1. Document why (e.g., "audit trail for fraud prevention")
2. Set a retention period
3. Ensure the proofs cannot be linked to user identity
4. Explain this in your privacy policy

### How should I verify proofs securely?

Use the official Opaque verifier smart contract, pinned in the `deployments/` manifest:

```typescript
// Good: Uses contract from manifest
const contractId = deployments.contracts.verifier.address;

// Bad: Hardcodes an old address
const contractId = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
```

---

## Attestations and Revocation

### How do I revoke an attestation?

You cannot directly revoke an attestation (the attestor issued it, they control it). Instead:

1. **Stop using the attestation**: Do not include it in new proofs
2. **Request revocation from the issuer**: If the attestation is outdated or incorrect, ask the issuer to revoke it
3. **Revoke in your wallet**: Mark the attestation as untrusted locally (prevents accidental use)

### What happens if an attestor revokes my attestation?

1. The attestation remains on-chain (immutable)
2. The issuer's key is marked as revoked in the registry
3. Applications that trust only current (non-revoked) keys will reject proofs using that attestation
4. Applications can choose to accept revoked keys (less secure)

### Can I see who issued my attestations?

Yes. The wallet displays the issuer's key fingerprint. Applications can maintain a registry of known issuers (e.g., "KYC verified", "Trusted exchanges").

---

## Frequently Asked Questions (Quick Answers)

| Q | A |
|---|---|
| **Can my stealth address be linked to my main address?** | Only if you voluntarily reveal it or reuse keys across contexts. Opaque's design prevents automatic linking. |
| **If I lose my stealth key, can I recover my attestations?** | No. Attestations are encrypted to the stealth key. Loss of the key means loss of access. Always back up stealth keys. |
| **Can an application see my other attestations?** | No. The proof only reveals that you meet the required traits, not which specific attestations you used. |
| **Is proof generation instant?** | No. Groth16 proof generation takes 5-30 seconds on modern hardware, depending on circuit complexity. |
| **Can I prove negative traits (e.g., "I don't have an account from Country X")?" | Technically possible but uncommon. Most circuits prove positive traits (presence, not absence). |
| **What if my browser crashes during proof generation?** | Your wallet state is not affected. Restart the browser and retry. No proofs are sent until you explicitly confirm. |
| **Can I use the same proof for multiple logins?** | No. Nullifiers prevent reuse. Each login requires a fresh proof. |

---

## Support and Resources

- **Report a bug**: GitHub issues on [collinsadi/opauque-stellar](https://github.com/collinsadi/opauque-stellar)
- **Wallet UI guide**: [reputation-ux-guide.md](reputation-ux-guide.md)
- **Schema authoring**: [SCHEMA_AUTHORING_GUIDE.md](SCHEMA_AUTHORING_GUIDE.md)
- **Circuit documentation**: [circuits/](../circuits/)
- **Reference implementation**: [scanner/src/proof.rs](../../scanner/src/proof.rs)

---

**Last updated**: June 2024
**Version**: 1.0
