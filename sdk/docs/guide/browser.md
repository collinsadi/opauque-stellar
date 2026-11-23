# Browser (Freighter)

The SDK ships a Freighter signer on its own subpath. `@stellar/freighter-api`
is an optional peer dependency: install it to use this signer.

```ts
import { OpaqueClient } from "@opaquecash/stellar";
import { freighterSigner } from "@opaquecash/stellar/freighter";

const opaque = new OpaqueClient({ network: "testnet", signer: freighterSigner() });
```

A user rejection fails with `SignerRejectedError`; other wallet errors with
`SignerError`. `publicKey()` always reads Freighter's active account, and signing
with a different account than the transaction was built for fails with
`SignerError` `reason: "account-changed"`. Without `@stellar/freighter-api`
installed, the signer fails with `MissingPeerDependencyError`.

You can also adapt any wallet with `callbackSigner` — the SDK never sees a
private key:

```ts
import { OpaqueClient, callbackSigner } from "@opaquecash/stellar";
import {
  getAddress,
  signTransaction,
} from "@stellar/freighter-api";

const { address } = await getAddress();

const opaque = new OpaqueClient({
  network: "testnet",
  signer: callbackSigner({
    publicKey: address,
    signTransaction: async (xdr) => {
      const { signedTxXdr } = await signTransaction(xdr, {
        networkPassphrase: "Test SDF Network ; September 2015",
      });
      return signedTxXdr;
    },
  }),
});
```

## Identity derivation

Deriving stealth keys needs one signed message. Use Freighter's message signing
to produce the entropy, then derive:

```ts
const identity = opaque.payments.deriveIdentity(signatureHex);
await opaque.payments.register({ metaAddress: identity.metaAddress });
```

## Storage

Plug your app's persistence so notes and scan cursors survive reloads:

```ts
new OpaqueClient({
  network: "testnet",
  signer,
  storage: { notes: myIndexedDbNoteStore },
});
```

Any object implementing `NoteStore` / `VaultStore` / `ScanStore` works; the
default is in-memory.

## Circuit artifacts in the browser

Serve the circuit files as static assets and resolve them by URL:

```ts
import { urlArtifactResolver } from "@opaquecash/stellar";

new OpaqueClient({
  network: "testnet",
  signer,
  artifacts: urlArtifactResolver({ baseUrl: location.origin }),
});
```
