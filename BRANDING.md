# Trademark & Branding Guidelines

These guidelines cover use of the **Opaque** name, wordmark, and visual assets by
integrators, forks, and third parties. They apply in addition to, not instead of, the
[MIT License](LICENSE).

## Naming

- **Opaque** (or **Opaque Protocol**) is the name of the privacy protocol — DKSAP
  stealth addresses plus on-chain ZK reputation — implemented across multiple chains.
- **opauque-stellar** is the repository slug for this specific implementation
  (Stellar/Soroban). It is a repo name, not a brand name — do not present
  "opauque-stellar" as a product name in user-facing UI, marketing, or app listings.
  Use "Opaque" or "Opaque (Stellar)" instead.
- The sibling Solana implementation lives at
  [opaque-solana](https://github.com/collinsadi/opaque-solana).

## Logo assets

Logo, wordmark, favicon, and social/OG image assets are generated and downloadable
in-app at [`/branding`](frontend/src/components/BrandingPage.tsx) (served from the
running frontend, e.g. `https://<your-deployment>/branding`). The static favicon SVG
also ships in the repo at [`frontend/public/favicon.svg`](frontend/public/favicon.svg).

There is no separate static logo file checked into the repo beyond the favicon — the
wordmark and OG images are generated client-side by `BrandingPage.tsx` from the same
source definitions used in production, so downloading from `/branding` always gives you
the current mark.

## Permitted uses

- Using the unmodified Opaque wordmark/logo to link to or accurately describe this
  project (e.g. "built on Opaque", "powered by the Opaque protocol").
- Using the logo in technical documentation, integration guides, or talks that
  accurately describe your use of the protocol.
- Forking the code under the MIT License and building your own product, **provided**
  you do not use the Opaque name or logo to imply your fork is the official project or
  is endorsed by it (see below).

## Prohibited uses

- Using the Opaque name or logo in a way that implies official endorsement,
  partnership, or affiliation where none exists.
- Modifying the logo (recoloring, distorting, combining with other marks) and
  presenting it as the official mark.
- Using "Opaque" as the primary name of an unaffiliated fork, wallet, or service in a
  way likely to confuse users about which project they're using.
- Using the branding in connection with phishing, scams, or any deployment that
  misrepresents itself as an official Opaque deployment. Report suspected misuse via
  the [Abuse & Sanctions Response Policy](frontend/src/components/AbusePolicyPage.tsx)
  (`abuse@opaqueprotocol.org`).

## MIT License interaction

The MIT License in this repository covers the **source code** — you may copy, modify,
and redistribute the code, including for commercial purposes, without asking
permission. It does **not** grant rights to the **Opaque name or logo** beyond the
permitted uses above. Trademark and source-code licensing are separate: you can fork
and ship code freely under MIT, but you must rebrand if your fork could be confused
with the official project or isn't using the marks under a permitted use.

## Questions

For branding or trademark questions not covered here, open a
[GitHub issue](https://github.com/collinsadi/opauque-stellar/issues/new) or email
abuse@opaqueprotocol.org.
