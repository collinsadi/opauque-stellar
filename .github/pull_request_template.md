## What & why

<!-- What does this change do, and why is it needed? -->

## Closed issues

<!--
One line per issue this PR closes. For each, link the CODE that implements it —
a file and line range, a commit, or a test — not a description of the change.
A Markdown note describing a fix (e.g. a `*.patch.md`) does not close an issue;
the change itself must be in the diff. See #1089.

Example:
Closes #123 — fix: frontend/src/lib/foo.ts (bar() bounds the loop), test: frontend/src/lib/__tests__/foo.test.ts
-->

- Closes #

## Type of change

- [ ] feat — new functionality
- [ ] fix — bug fix
- [ ] refactor — no behavior change
- [ ] docs
- [ ] test
- [ ] chore
- [ ] contracts (touches Soroban bytecode, events, or storage layout)

## Required checks (all must pass — see CONTRIBUTING.md §4)

- [ ] `cargo fmt --all -- --check`
- [ ] `cargo clippy --workspace --all-targets -- -D warnings`
- [ ] `cargo test --workspace --locked`
- [ ] `stellar contract build`
- [ ] Frontend: `npm run lint`, `npm run typecheck`, `npm run build`, `npx vitest run`
- [ ] `npm run verify:deployment`

## Impact checklist

- [ ] No secrets, `.env`, or build artifacts committed
- [ ] Tests added/updated (no tests deleted or weakened without justification below)
- [ ] Every closed issue above links to code in this diff, not to a description of the change
- [ ] If contracts/scanner/circuits changed: WASM/artifact hashes + manifests updated
- [ ] If event ABI / storage layout changed: scanner updated and version bumped
- [ ] Docs / README updated if commands or behavior changed

## Notes for reviewers

<!-- Anything tricky, any ignored/quarantined tests + reason, follow-ups. -->
