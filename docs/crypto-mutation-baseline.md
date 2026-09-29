# Frontend Crypto Mutation Baseline

Mutation testing covers `frontend/src/lib/stealth.ts`, which contains the frontend DKSAP implementation and helpers. The configured minimum mutation score is 55%; 70% is the high threshold.

Run locally with:

```sh
npm ci --prefix frontend
npm run test:mutation --prefix frontend
```

The generated JSON report is written under `frontend/reports/mutation/mutation.json` by the Stryker default reporter configuration. Mutation runs are intentionally opt-in in CI because they are substantially slower than the unit test job.

## Baseline

Baseline recorded on 2026-08-25 with Node.js 22.17.1: 55.13% mutation score, 84 mutants killed, 2 timed out, and 70 survived out of 156 generated mutants. The run used `private-payment-lifecycle.test.ts`, the focused test that imports the production DKSAP implementation.

The survivor review found three groups: diagnostic and display-string mutations, equivalent branch mutations caused by the public `Hex | string` types, and meaningful crypto/input-validation gaps. The meaningful survivors include domain-separation constants, compressed-point selection, malformed hex handling, ephemeral key length, scalar reduction, and deterministic Stellar key derivation. These are the priority cases for focused tests before raising the threshold. New changes must not reduce the score below 55%.
