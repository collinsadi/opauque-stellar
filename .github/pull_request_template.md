## What & why

<!-- What does this change do, and why is it needed? Link any issues. -->

## Type of change

- [ ] feat — new functionality
- [ ] fix — bug fix
- [ ] refactor — no behavior change
- [ ] docs
- [ ] test
- [ ] chore / ci
- [ ] contracts (touches Soroban bytecode, events, or storage layout)

## Required checks (all must pass — see CONTRIBUTING.md §4)

- [ ] `cargo fmt --all -- --check`
- [ ] `cargo clippy --workspace --all-targets -- -D warnings`
- [ ] `cargo test --workspace --locked`
- [ ] `stellar contract build`
- [ ] Frontend: `npm run lint`, `npx tsc -b --noEmit`, `npm run build`, `npx vitest run`
- [ ] `npm run verify:deployment`

## Impact checklist

- [ ] No secrets, `.env`, or build artifacts committed
- [ ] Tests added/updated (no tests deleted or weakened without justification below)
- [ ] Theme audit completed: production views use design tokens, with no hardcoded light-only `bg-white`, `text-gray-*`, `bg-gray-*`, or `border-gray-*` classes
- [ ] If contracts/scanner/circuits changed: WASM/artifact hashes + manifests updated
- [ ] If circuits changed: constraint thresholds in `circuits/constraint-thresholds.json` verified and updated if needed
- [ ] If event ABI / storage layout changed: scanner updated and version bumped
- [ ] Docs / README updated if commands or behavior changed

## Notes for reviewers

<!-- Anything tricky, any ignored/quarantined tests + reason, follow-ups. -->
