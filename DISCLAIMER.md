# Disclaimer

## Experimental Software

Opaque is **experimental, unaudited software** provided on an "as-is" basis. It has **not** undergone a formal security audit. Use it at your own risk.

## No Guarantees of Privacy

While the protocol is designed to provide unlinkable receive addresses and selective disclosure of reputation, **no privacy system is perfect**. Specific risks include:

- **Metadata leakage.** On-chain transactions carry timing, amount, and fee-payer information that sophisticated observers may use for statistical linkage analysis.
- **Local data loss.** Ghost addresses rely on local device storage. Lost data may make funds **permanently inaccessible** with no on-chain recovery.
- **Scanner limitations.** The WASM scanner depends on complete announcement data from RPC or Horizon. Missed events may delay detection until a rescan.
- **View-tag false positives.** Roughly 1 in 256 announcements pass the view-tag filter without being yours, requiring full derivation to confirm.

## Cryptographic Assumptions

Security relies on:

- **ECDLP hardness** on secp256k1.
- **Groth16 soundness** on BN254 with a trusted setup (development artifacts in-repo are not production-ready).
- **Keccak-256** and **Poseidon** collision resistance.

## Smart Contract Risks

Soroban contracts deployed on Stellar testnet have **not been formally verified**. Risks include logic bugs, admin-controlled Merkle roots, growing nullifier state, and upgrade authority if contracts are not immutable.

## Not Financial Advice

Nothing here is financial, legal, or tax advice. Comply with applicable laws in your jurisdiction.

## Testnet Default

Default configuration targets **Stellar testnet**. Test XLM has no monetary value.

## Mainnet Production Use

When configured for **Stellar Mainnet**, privacy payment features use **real XLM**. Risks include:

- **Irreversible transactions.** Sends, sweeps, and account reserves consume real funds.
- **Regulatory and sanctions exposure.** Privacy tools may be restricted in some jurisdictions; users must comply with applicable law.
- **No production audit.** Contracts and frontend are experimental and not formally audited for mainnet.
- **Incomplete privacy.** On-chain metadata and off-chain observability may still deanonymize activity.

Do not enable mainnet until you have reviewed the Terms, Privacy Policy, Disclaimer, and [MAINNET_LEGAL_REVIEW.md](MAINNET_LEGAL_REVIEW.md).

## No Warranty

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

---

By using this software, you acknowledge that you have read, understood, and accepted the risks described above.
