# Node (server keypair)

On a server, sign with a raw Stellar keypair and generate proofs from circuit
artifacts on disk.

## Signer

```ts
import { OpaqueClient, keypairSigner } from "@opaquecash/stellar";

const opaque = new OpaqueClient({
  network: "testnet",
  signer: keypairSigner(process.env.STELLAR_SECRET!),
});
```

`keypairSigner` accepts a secret seed (`S...`) or a `Keypair` instance.

## Generating proofs

Circuit `.wasm` / `.zkey` files are large and ship via a release, not the npm
package. Point a resolver at a local directory (or a URL with
`urlArtifactResolver`):

```ts
import { OpaqueClient, fileArtifactResolver, keypairSigner } from "@opaquecash/stellar";

const opaque = new OpaqueClient({
  network: "testnet",
  signer: keypairSigner(process.env.STELLAR_SECRET!),
  artifacts: fileArtifactResolver({ baseDir: "./circuits-dist" }),
});

const proof = await opaque.reputation.prove({
  attestationId,
  stealthPrivKey,
  externalNullifier: 42n,
  attestationWitness,
  publisherProof,
});
const txHash = await opaque.reputation.verifyOnChain(proof);
```

The resolver looks for `circuits/v2/stealth_reputation.wasm` and
`circuits/v2/stealth_reputation_final.zkey` (reputation), and the `v3`
`privacy_pool_withdraw.*` files (pool) under `baseDir`.

## Clean process exit

`snarkjs` keeps worker threads alive after proving. Call `opaque.dispose()`
when your work is done to terminate them and release resources; the script then
ends naturally, which also works inside servers and test runners:

```ts
try {
  await opaque.reputation.verifyOnChain(proof);
} finally {
  await opaque.dispose();
}
```

## Runnable example

See [`examples/node-quickstart.mjs`](https://github.com/collinsadi/opaque-stellar/blob/main/sdk/examples/node-quickstart.mjs):

```sh
node examples/node-quickstart.mjs
# also generate a real proof:
OPAQUE_CIRCUITS_DIR=/path/to/public node examples/node-quickstart.mjs
```
