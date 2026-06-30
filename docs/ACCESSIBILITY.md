# Accessibility Conformance Statement

## Target conformance level

Opaque Stellar targets **WCAG 2.1 Level AA**. This is a target, not a certification —
the application has not undergone a third-party accessibility audit. Conformance is
based on internal manual review using keyboard navigation and screen reader spot
checks (VoiceOver, NVDA).

## Tested views

Manual accessibility review has been performed on the following views in
`frontend/src/components/`:

| View | Component |
|:-----|:----------|
| Landing page | `LandingPage.tsx` / `LandingView.tsx` |
| Wallet setup | `SetupView.tsx` |
| Registration | `RegistrationView.tsx` |
| SEP-10 auth | `Sep10AuthView.tsx` |
| Dashboard | `DashboardView.tsx` |
| Send | `SendView.tsx` |
| Receive | `ReceiveView.tsx` |
| Private balance | `PrivateBalanceView.tsx` |
| Transaction history | `TransactionHistoryView.tsx` |
| Profile | `ProfileView.tsx` |
| Manage | `ManageView.tsx` |
| My traits | `MyTraitsView.tsx` |
| Reputation dashboard | `ReputationDashboardView.tsx` |
| Pay / Pay success | `PayPage.tsx`, `PaySuccessPage.tsx` |
| Legal pages (Privacy, Terms, Disclaimer, Abuse policy) | `LegalPageLayout.tsx` and children |

Views not yet reviewed (operator-only or internal tooling, e.g. `OperatorDashboard.tsx`,
`BrandingPage.tsx`) are out of scope for this statement since they are not part of the
public end-user flow.

## Known gaps

- **No automated accessibility enforcement in CI.** Violations are currently caught
  only in manual passes; there is no axe-core/Lighthouse gate blocking regressions.
  Tracked in [#472](https://github.com/collinsadi/opauque-stellar/issues/472).
- Color contrast, full keyboard operability, and screen reader labeling have not been
  audited end-to-end against WCAG 2.1 AA success criteria; gaps found during the manual
  review above are filed individually under the
  [`accessibility` label](https://github.com/collinsadi/opauque-stellar/labels/accessibility)
  as they're discovered.

This statement is updated as gaps are closed or new ones are found. If a gap you hit
isn't listed above, please report it (see Contact).

## Contact

Found an accessibility barrier? Report it:

- **Email:** accessibility@opaqueprotocol.org
- **GitHub:** [open an issue](https://github.com/collinsadi/opauque-stellar/issues/new)
  with the `accessibility` label

We aim to acknowledge accessibility reports within 5 business days, consistent with our
[abuse and security reporting SLAs](../SECURITY.md).
