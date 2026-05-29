# Ghost Address Key Storage — Threat Model

For user-facing backup and recovery steps (payment-link vs manual ghost, device migration), see [USER_RECOVERY.md](./USER_RECOVERY.md).

## What is protected

Ephemeral private keys (`ephemeralPrivKeyHex`) for ghost addresses are encrypted
at rest in `localStorage` using AES-256-GCM with a password-derived key (PBKDF2,
600k iterations, SHA-256). The password is held in memory only and never persisted.

An attacker who reads `localStorage` (e.g. via a browser extension with storage
access, or a same-origin XSS that exfiltrates storage contents) obtains only
ciphertext. Without the password, the ephemeral keys cannot be recovered.

## Residual risks

### 1. XSS at password entry time

If an attacker has injected JavaScript before the user enters their password,
they can capture the password from the DOM input event. This bypasses all
encryption because the attacker obtains the key derivation input directly.

**Mitigation:** Content-Security-Policy headers, input sanitization, and
auditing third-party scripts reduce XSS surface area.

### 2. Runtime memory inspection

While the app is running, decrypted ephemeral keys and the password exist in
JavaScript heap memory. A browser extension with debug-protocol access, a
DevTools session, or a memory dump can extract them.

**Mitigation:** Clear `clearGhostPassword()` on logout. Minimize the window
during which keys are decrypted. This is a fundamental browser limitation.

### 3. Compromised browser extensions

Extensions with broad permissions can read the DOM, intercept network requests,
and access `localStorage`. A malicious extension can capture the password at
entry time or read decrypted keys from memory.

**Mitigation:** Users should minimize installed extensions and audit permissions.
No client-side code can fully defend against a privileged extension.

### 4. Backup export security

Exported backups are encrypted with the same password. If the password is weak,
the backup file is vulnerable to offline brute-force. The PBKDF2 iteration count
(600k) makes this expensive but not impossible for weak passwords.

**Mitigation:** Users should choose strong, unique passwords. Consider storing
backups in an encrypted vault (e.g. password manager).

### 5. Password brute-force on stored ciphertext

An attacker with read access to `localStorage` can attempt offline brute-force
against the PBKDF2-protected ciphertext. With 600k iterations, this is slow but
feasible for short or common passwords.

**Mitigation:** Strong passwords. The iteration count is aligned with OWASP 2023
recommendations for PBKDF2-SHA256.

## What is NOT stored plaintext

After this change, `localStorage` under key `opaque-ghost-addresses` contains:
- `version`, `salt`: encryption metadata (not secret)
- `cluster`, `stealthAddress`, `createdAt`: address metadata (not secret)
- `ephemeralPrivKeyEncrypted`: AES-256-GCM ciphertext of the ephemeral key

No private key material is stored in plaintext.
