# User Recovery Guide

Opaque keeps most sensitive data **on your device**. There is no server-side recovery. Understanding what is stored where — and what you must back up — prevents permanent loss of funds.

---

## What must be backed up

| Data | Required for | Stored where | Backup method |
|------|--------------|--------------|---------------|
| **Wallet + signing access** | Deriving your master stealth keys | Your wallet (Freighter) | Secure your wallet seed phrase / recovery phrase |
| **Master stealth keys** (viewing + spending) | Finding and withdrawing **payment-link** receives | Browser memory only while session is active | Re-sign the domain-separated setup message with the same wallet on any device |
| **Ghost ephemeral keys** | Withdrawing **manual ghost** receives | `localStorage` in the browser that generated them | Export encrypted ghost backup, or copy the full ghost entry including the ephemeral key |
| **Ghost address only** (no ephemeral key) | Viewing balance only | Watchlist / import | **Cannot withdraw** — you need the ephemeral key |

**Rule of thumb:** If funds arrived via a **payment link** or standard Opaque send, you only need your wallet. If funds arrived at a **manual ghost address**, you need the browser data (or a backup of the ephemeral key) from when that address was generated.

---

## Signature-derived master keys

Your stealth **viewing** and **spending** private keys are derived deterministically from a wallet signature:

1. You sign a domain-separated message in Freighter (includes app origin, Stellar network passphrase, your wallet public key, and purpose `stealth-key-derivation`).
2. The signature bytes are expanded with **HKDF-SHA256** (domain `"opaque-cash-v1"`) into 64 bytes: first 32 = viewing key, next 32 = spending key.
3. Public keys on secp256k1 form your **66-byte stealth meta-address** (`0x` + 64 hex chars).

Because derivation is deterministic, **the same wallet signing the same message always produces the same keys**. Opaque never stores raw master keys on disk — they live in browser memory until you disconnect or close the tab.

### Recovering master keys on a new device

1. Install Freighter and restore the **same wallet** you used originally.
2. Open Opaque on the target network (testnet/mainnet must match).
3. Connect and sign the setup message when prompted.
4. Wait for the scanner to sync — payment-link receives appear via on-chain announcements.

> **Testnet migration:** Older sessions used a legacy setup message. Testnet users are automatically migrated to the domain-separated message on next sign-in.

---

## Browser and session behavior

Opaque splits data across several browser stores:

| Store | Contents | Lifetime |
|-------|----------|----------|
| **Memory (React state)** | Master viewing/spending keys | Until disconnect or tab close |
| **`sessionStorage`** | Optional cached wallet signature (AES-GCM encrypted) | ~30 minutes, **this tab only** |
| **`localStorage`** | Ghost addresses, vault entries, security flags | Until cleared manually or browser data wiped |

### “Remember signature for this tab”

When enabled, Opaque caches your wallet signature in `sessionStorage` for about **30 minutes** so you are not prompted to sign again on every page refresh **within the same tab**.

This is a **convenience feature**, not a backup:

- It expires after 30 minutes or when you disconnect.
- It is scoped to one browser tab — other tabs and devices do not share it.
- Clearing site data removes it immediately.

**Permanent recovery** always requires re-signing with your wallet, not the cached session.

### Disconnect / logout

Disconnecting clears in-memory master keys and the signature session. It does **not** delete ghost addresses or vault entries from `localStorage`.

---

## Two ways to receive: payment link vs manual ghost

These flows have **different recovery properties**. Choose based on how the sender will pay you.

### Payment link receives (recommended)

**What you share:** Your permanent meta-address or an `opaque://v1/{network}/{metaAddress}` link.

**How it works:**

1. Sender uses Opaque (or a compatible integrator) to derive a one-time stealth address from your meta-address.
2. Sender pays XLM and publishes an on-chain announcement.
3. Your scanner finds the announcement via view-tag filtering and derives the stealth key to withdraw.

**Recovery:** Works on **any device** once you restore the same wallet and re-sign the setup message. No browser-specific backup is required for the receive itself.

**Best for:** Ongoing receiving, cross-device use, senders using Opaque or payment links.

See also: [OPAQUE_PAYMENT_LINK_FORMAT.md](./OPAQUE_PAYMENT_LINK_FORMAT.md)

### Manual ghost receives (one-time, browser-bound)

**What you share:** A single `0x…` stealth address (or QR code) generated locally.

**How it works:**

1. Opaque generates a random **ephemeral private key** and derives a one-time stealth address.
2. The ephemeral key is saved in this browser’s `localStorage` (optionally password-encrypted).
3. The sender pays the raw address directly — they may **not** use the on-chain announcer.
4. Opaque polls the address balance locally and uses the stored ephemeral key to withdraw.

**Recovery:** **Browser-bound by default.** Another device cannot discover or claim these funds unless you:

- Export and import an encrypted ghost backup on the new browser, or
- Manually import the ghost address **with its ephemeral private key** (address-only import shows balance but cannot withdraw).

**Best for:** One-off receives from wallets or services that cannot use Opaque payment links.

See also: [GHOST_THREAT_MODEL.md](./GHOST_THREAT_MODEL.md)

### Comparison

| | Payment link | Manual ghost |
|---|-------------|--------------|
| Share | Meta-address / `opaque://` link | One-time `0x` address |
| Sender needs Opaque? | No (link or meta-address is enough) | No |
| On-chain announcement | Yes (typical) | Optional (can announce later) |
| Cross-device recovery | Yes — re-sign wallet | No — needs local ghost backup |
| Ephemeral key backup | Not required | **Required** |

---

## Ghost address backups

Manual ghost entries in `localStorage` include:

- `stealthAddress` — the `0x…` address you shared
- `ephemeralPrivKeyHex` — the 32-byte ephemeral private key needed to withdraw
- `cluster`, `createdAt` — metadata

### What to back up

Always preserve **`ephemeralPrivKeyHex`** for every manual ghost that may still hold funds. Without it, funds on that address are **permanently inaccessible** — there is no on-chain recovery path.

Metadata alone (address without key) lets you **see** a balance but not **claim** it.

### Encrypted ghost export

Ghost entries can be encrypted at rest with a user password (PBKDF2, 600k iterations + AES-256-GCM). Exported backups use the same encryption. Store backup files in a password manager or encrypted vault — weak passwords are vulnerable to offline brute-force.

### Importing on another device

1. Restore the same wallet in Freighter and complete Opaque setup (re-sign).
2. Import the ghost backup or add the ghost entry with its ephemeral key via **Private balance → Import ghost**.
3. Refresh balances and withdraw as usual.

Address-only import is useful for monitoring but **cannot** withdraw without the ephemeral key.

---

## Device migration checklist

### Moving to a new browser or computer (payment-link funds)

- [ ] Restore the same Freighter wallet (same seed phrase).
- [ ] Connect to the **same network** (testnet vs mainnet).
- [ ] Sign the Opaque setup message.
- [ ] Wait for scanner sync to complete.
- [ ] Verify private balance and withdraw test funds.

### Moving manual ghost funds

- [ ] **Before** retiring the old browser: export encrypted ghost backup, or securely record each active ghost’s `ephemeralPrivKeyHex`.
- [ ] On the new browser: complete wallet setup, then import ghost backup or entries.
- [ ] Confirm each ghost address appears under Private balance.
- [ ] Withdraw or announce on-chain before deleting old browser data.

### Before clearing browser data

- [ ] Confirm no pending manual ghost addresses hold funds (check Private balance).
- [ ] Export ghost backups if any manual receives are still active.
- [ ] Note: clearing data removes ghost entries and vault cache; payment-link receives are recoverable via wallet re-sign after re-sync.

---

## What Opaque cannot recover

- Manual ghost funds when the ephemeral private key is lost and was never backed up.
- Funds sent to the wrong network (testnet vs mainnet mismatch).
- Funds sent to a ghost address generated in a browser whose `localStorage` was wiped without backup.
- Master keys if you lose wallet access (seed phrase) — the signature derivation requires the same wallet.

---

## Related documentation

- [GHOST_THREAT_MODEL.md](./GHOST_THREAT_MODEL.md) — Ghost key encryption and threat model
- [OPAQUE_PAYMENT_LINK_FORMAT.md](./OPAQUE_PAYMENT_LINK_FORMAT.md) — Payment link specification
- [DISCLAIMER.md](../DISCLAIMER.md) — Experimental software risks
