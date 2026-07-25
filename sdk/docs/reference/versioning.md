# Versioning & Deprecation Policy

`@opaquecash/stellar` follows [Semantic Versioning 2.0.0](https://semver.org/).
A version is `MAJOR.MINOR.PATCH`:

- **MAJOR** — a breaking change to the public API.
- **MINOR** — new, backward-compatible functionality (including new deprecations).
- **PATCH** — backward-compatible bug fixes.

The **public API** is everything exported from the package entry points:

- `@opaquecash/stellar` (root)
- `@opaquecash/stellar/crypto`
- `@opaquecash/stellar/relayer-protocol`

Anything not exported from those entry points is internal and may change in any
release without notice, even if it is technically reachable via a deep import.

## What counts as a breaking change

A change is **breaking** (requires a MAJOR bump) when it can force a compiling,
correct consumer to change their code or observe different runtime behavior:

- Removing or renaming a public export (type, function, class, constant).
- Changing a function/method signature incompatibly — removing a parameter,
  making an optional parameter required, reordering parameters, narrowing an
  accepted input type, or widening/changing a return type.
- Changing documented default behavior (e.g. a default fee, scope, timeout, or
  retry policy that callers rely on).
- Removing or renaming a public error `code`, error class, or contract-error name.
- Removing a subpath export or changing the module format of an entry point.
- **Dropping a supported Node.js version** (the `engines.node` floor). The
  current floor is **Node.js >= 20**; raising it is a breaking change.
- Bumping a `peerDependency` to a range that excludes a previously supported
  major (e.g. requiring `@noble/*` v2 when v1 was supported).

## What is _not_ breaking

These ship in MINOR or PATCH releases:

- Adding a **new optional parameter** to an existing function (with a safe default).
- Adding a **new export** (function, type, class, constant) or a new subpath.
- Adding a new optional field to a returned object.
- Internal refactors, performance work, and dependency updates that keep the
  public API and documented behavior identical.
- Bug fixes that bring behavior in line with documented behavior. (A fix that
  changes _documented_ behavior is breaking; a fix that corrects behavior which
  contradicted the docs is not.)
- Widening an accepted input type, or adding a new accepted variant.

## Deprecation policy

We deprecate before we remove. The guarantees:

1. **Announcement.** An API is marked deprecated in a **MINOR** release. The
   deprecation is recorded with a `@deprecated` JSDoc tag (so it surfaces in
   editors and type-checkers) and a `### Deprecated` entry in the
   [changelog](#changelog-format), naming the replacement.
2. **Survival window.** A deprecated API is **not removed before the next MAJOR
   release**, and in no case sooner than **6 months** after the release that
   deprecated it — whichever is later. Within that window the API keeps working
   unchanged.
3. **Removal.** Removal happens only in a MAJOR release and is listed under
   `### Removed` in that release's changelog entry, again naming the migration
   path.

Security issues are the only exception: if a deprecated API cannot be kept safe,
it may be changed or removed faster, and the release notes will say so explicitly.

Because the SDK is pre-1.0 (current version `0.x`), SemVer treats the **MINOR**
segment as the breaking-change signal: while on `0.x`, a breaking change bumps
the MINOR (`0.2.0` -> `0.3.0`) and additive changes bump the PATCH. The
deprecation window above is measured against that same "next breaking release"
boundary until `1.0.0` is cut.

## Changelog format

The changelog lives in [`sdk/CHANGELOG.md`](../../CHANGELOG.md) and is generated
by [Changesets](https://github.com/changesets/changesets). Each released version
is an `## <version>` heading, grouped by the kind of bump it contained:

```
## 0.3.0

### Minor Changes

- Short, imperative description of the change.

### Patch Changes

- Bug fix description.
```

To categorize deprecations and removals precisely, entries may also use the
[Keep a Changelog](https://keepachangelog.com/) section names — `Added`,
`Changed`, `Deprecated`, `Removed`, `Fixed`, `Security` — as sub-bullets or
sub-headings within a change group. Unreleased work accumulates under a leading
`## Unreleased` section (via `pnpm/npm changeset`), which is renamed to the
version number at release time.

Every change that touches the public API **must** ship with a changeset so it
lands in the changelog; internal-only changes may omit one.
