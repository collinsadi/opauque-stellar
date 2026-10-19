# User Key Management Guide

Opaque Stellar users hold several distinct secrets. Each has different loss and theft consequences. This guide explains each secret, the risks of losing or compromising them, and backup practices for casual and high-security users.

## Overview of user secrets

| Secret | Purpose | Loss consequence | Theft consequence | Backup priority |
|--------|---------|-----------------|-------------------|-----------------|
| **Wallet key** | Main account funding source | Cannot withdraw funds from privacy pool | Attacker can spend all XLM and steal withdrawal proofs | Critical |
| **Stealth key** | Decrypt incoming private payments | Miss incoming anonymous payments | Attacker can scan your private payments | High |
| **Note key** | Prove ownership of privacy pool deposits | Cannot withdraw anonymously; funds locked forever | Can be exploited to withdraw your deposits | Critical |
| **Password** | Encrypts all secrets in browser storage | All encrypted secrets are permanently inaccessible | Attacker can decrypt all secrets if stored locally | Critical |

## Secrets explained

### Wallet Key

**What it is:** The private key to your main Freighter wallet account. Used to:
- Deposit XLM into the privacy pool
- Pay relayer fees
- Authorize on-chain transactions
- Sign withdrawal proofs for submission

**Loss consequence:** Your main account becomes inaccessible. Funds in the privacy pool are locked unless you recover the key or use an offline backup. The account remains on-chain but you cannot prove ownership.

**Theft consequence:** Total loss of funds. An attacker can:
- Spend your XLM balance
- Create fake notes and withdraw through the pool
- Intercept and replay withdrawal transactions

**Recovery:** Freighter manages this key via the browser extension. See Freighter's official backup guide. **Never** export this key unless you are backing up your entire Freighter instance.

### Stealth Key

**What it is:** Derived from your wallet key. Used to receive private payments and scan announcements. The stealth key is mathematically bound to your meta-address published in the stealth registry.

**Loss consequence:** You cannot scan for new incoming private payments after losing the key. Payments sent to your meta-address will remain on-chain unspent. Old payments you already scanned and swept are unaffected.

**Theft consequence:** An attacker can scan your transaction history and learn:
- Which stealth payment announcements are yours
- The amounts you received
- The timestamps of payments (correlatable with on-chain metadata)

The attacker cannot forge new announcements in your name or spend your funds (the stealth account itself holds the XLM, not your keys).

**Recovery:** Your stealth key is derived from your wallet key. If you have access to Freighter and your wallet key, you can regenerate your stealth key and re-scan the ledger from a known block.

### Note Key

**What it is:** A private secret uniquely associated with each deposit in the privacy pool. Proves your ownership of a private note during withdrawal.

**Loss consequence:** You cannot withdraw a specific deposit from the privacy pool. The note becomes a permanent orphan on-chain. Funds are inaccessible even if you create a new wallet. Recovery requires an offline backup of the note key or regeneration from your wallet key and deposit history.

**Theft consequence:** Severe. An attacker can:
- Generate a valid withdrawal proof for your deposit
- Withdraw your funds to any address they control
- Prevent you from withdrawing by invalidating nullifiers

An attacker with access to your note keys can extract all of your privacy pool funds.

**Recovery:** Note keys must be backed up at deposit time. If you do not have an offline backup, you must regenerate from your wallet key and the pool event history.

### Password

**What it is:** Protects all encrypted secrets stored in the browser's `localStorage`. The password:
- Is never sent to any server
- Is held only in memory while the app is running
- Is derived into an encryption key using a shared PBKDF2 configuration (see below)

**Unified KDF parameters.** Every wallet-encryption path (ghost-address keys, generic encrypted storage, pool-note backups, and the full recovery backup) derives its key with one shared configuration:

| Parameter | Value |
|-----------|-------|
| Algorithm | PBKDF2 |
| Hash | SHA-256 |
| Iterations | 600,000 |
| Salt | 16 bytes (random per payload) |
| Key length | 256 bits (AES-256-GCM) |

Encrypted payloads written before this unification carry their original iteration count in the file (or fall back to the legacy value) and continue to decrypt after the change.

**Loss consequence:** If you forget your password, all encrypted secrets (wallet key, stealth key, note keys, backups) stored in the browser become permanently inaccessible. You can only recover if you have an offline plaintext backup.

**Theft consequence:** Moderate to severe depending on your password strength.
- If your password is weak (< 8 characters, common words), an attacker with offline access to `localStorage` can brute-force it
- If your password is strong and unique, the 600,000 PBKDF2 iterations make brute-force infeasible

See [GHOST_THREAT_MODEL.md](GHOST_THREAT_MODEL.md) for browser storage risks.

**Recovery:** Use a strong, unique password. If you lose it, you can only recover from an offline plaintext backup you created beforehand.

## Backup practices

### For casual users (small amounts)

**Goal:** Recover access if you lose device or browser data.

**What to back up:**
1. Your Freighter seed phrase (non-negotiable; follow Freighter's official guidance)
2. Note keys from deposits (export after each deposit)

**How to back up:**
- Export Freighter's backup from the extension (password-protected)
- After each privacy pool deposit, export the note key (the wallet will prompt you)
- Store both exports in a password manager (e.g., Bitwarden, 1Password) encrypted with a strong master password
- Keep a printed copy of your Freighter seed phrase in a secure location (safe, safe deposit box)

**Do NOT:**
- Write your password in plaintext anywhere
- Store unencrypted note keys on cloud storage
- Take screenshots of your seed phrase or note keys

**Recovery time:** Minutes to hours. Restore Freighter, reimport your seed, re-scan the ledger.

### For high-security users (large amounts)

**Goal:** Defend against device compromise, theft, or long-term loss of access.

**What to back up:**
1. Your Freighter seed phrase (in secure offline storage)
2. This protocol's note keys and stealth key
3. A plaintext export of all secrets (for offline recovery)

**How to back up:**

**Step 1: Prepare offline storage**
- Use an airgapped machine (no network) or a hardware wallet setup (Ledger, Trezor)
- Encrypt all backups with a strong passphrase (25+ characters) using a tool like VeraCrypt or 7-Zip with AES-256
- Store encrypted backups on:
  - USB drives kept in a physical safe
  - Printed QR codes laminated and stored in a safe deposit box
  - Multiple geographic locations (with separate passphrases)

**Step 2: Backup secrets**
1. Export your Freighter seed phrase (follow Freighter's offline backup guidance)
2. In the Opaque Stellar app, use "Export all secrets" (plaintext, password-protected export)
3. Decrypt the export on your airgapped machine
4. Encrypt the plaintext with your offline passphrase using VeraCrypt
5. Store the encrypted container on USB and in your safe deposit box

**Step 3: Recovery procedure**
1. Decrypt the backup container on an airgapped machine
2. Restore Freighter from your seed phrase
3. In Opaque Stellar, use "Import secrets" to restore note keys and stealth key
4. Re-scan the ledger to find your deposits and announcements

**Step 4: Ongoing maintenance**
- After each large deposit, update your offline backup (especially the note key)
- Every 6 months, verify your backups are readable (decrypt and test recovery)
- If your password or passphrase is ever exposed, immediately rotate your keys and create new backups

**Do NOT:**
- Store unencrypted backups on networked devices
- Use the same passphrase for multiple backup containers
- Rely solely on cloud backups (Apple iCloud, Google Drive) without offline redundancy
- Store backups in a single location

**Recovery time:** Hours to days (depends on re-scanning the ledger). For amounts > $10,000, the overhead is worthwhile.

## What if your device is compromised?

### Immediate actions

1. **Stop using the device for Opaque Stellar**
   - Do not submit any more withdrawals or create new deposits
   - Do not attempt to "sweep" funds to safety using the compromised device

2. **Change your password** (if you can do so securely)
   - Log out and clear browser storage
   - Use a new, strong password when you restart

3. **Assess what was exposed**
   - If only your password: compromise is contained (use strong password)
   - If your stealth key: attackers can scan your transaction history
   - If your note keys: attackers can steal privacy pool deposits
   - If your wallet key: total account compromise

4. **Recover on a clean device**
   - Use your offline backup to restore keys
   - Re-scan the ledger to find remaining funds
   - If you had note keys or a wallet key compromised, consider moving funds to a new identity

### Preventing browser compromise

- Minimize browser extensions (uninstall anything unnecessary)
- Keep your browser and OS up to date
- Use a password manager with unique, strong passwords for each site
- Enable 2FA on email and any linked accounts
- Consider a dedicated browser profile or separate machine for Opaque Stellar on high-value accounts

## Key rotation

If you suspect your stealth key or note keys are compromised (but not your wallet key):

1. **Do not use the compromised key to withdraw**
2. **Create a new deposit and generate new note keys**
3. **Rotate your stealth key** by deriving a new stealth address from your wallet key and republishing to the stealth registry
4. **Migrate old funds** by using an intermediate privacy pool withdrawal to a relay address, then re-depositing under new keys

If your wallet key is compromised, you must:
1. Restore Freighter from a pre-compromise backup
2. Move all on-chain funds to a new wallet address
3. Regenerate all derived keys (stealth, notes)
4. Re-backup everything in a new offline storage location

## Accessibility vs. security tradeoff

| Strategy | Time to recover funds | Security level | Best for |
|----------|----------------------|-----------------|----------|
| Browser-only (password encrypted) | Seconds | Low (if password weak) | Testing, small amounts ($0-100) |
| Password manager backup | Minutes | Medium | Regular users with $100-1,000 |
| Printed seed + encrypted USB | Hours | High | Active users with $1,000-10,000 |
| Hardware wallet + airgapped backup | Days | Very high | High-value accounts > $10,000 |

Choose the strategy that matches your risk tolerance and the amount at stake.

## Summary checklist

**Every user should:**
- [ ] Know the difference between wallet keys, stealth keys, and note keys
- [ ] Back up Freighter seed phrase offline
- [ ] Understand the consequences of losing each key

**Regular users should:**
- [ ] Export note keys after each deposit
- [ ] Store backups in a password manager
- [ ] Test recovery once (recommended: backup and restore from scratch)

**High-security users should:**
- [ ] Set up offline encrypted storage (airgapped machine or USB)
- [ ] Create geographically redundant backups
- [ ] Verify backups quarterly
- [ ] Have a documented key rotation procedure

**All users should:**
- [ ] Use a strong, unique password (20+ characters, mixed case and symbols)
- [ ] Enable 2FA on email and linked accounts
- [ ] Keep browser and OS up to date
- [ ] Never share or screenshot your seed phrase or keys
