# Self-Serve Try PayOps Design

## Summary

PayOps will replace its application-based pilot entry with a self-serve `Try
PayOps` experience. Any visitor can open a realistic sample workspace without
signing up. A separate read-only path lets a visitor inspect supported public
wallet activity without connecting a wallet or sharing credentials.

The change is not a rename of the existing GitHub issue link. It creates a real
product destination that demonstrates PayOps immediately and preserves an
honest boundary between synthetic invoice reconciliation and facts available
from public Solana data.

## Goals

- Let a visitor reach a meaningful PayOps payment decision in one click.
- Require no pilot application, invitation, account, or sales conversation.
- Demonstrate invoice matching, exceptions, and evidence using realistic,
  deterministic sample data.
- Offer optional public-wallet analysis using read-only Solana data.
- Explain clearly when PayOps can verify a transfer and when it cannot infer an
  invoice match.
- Keep the sample experience available when live RPC analysis is degraded.
- Preserve the project's non-custodial and fail-closed security posture.

## Non-goals

- Public self-service organization creation.
- Access to the authenticated `/operations` dashboard.
- Wallet connection, transaction signing, custody, or fund movement.
- Persisting a visitor's wallet analysis as a merchant account or production
  record.
- Inferring invoice reconciliation from public wallet data alone.
- Supporting tokens other than canonical mainnet USDC and USDT in this release.

## Product Entry

All merchant-facing pilot actions become self-serve product actions:

| Surface | Copy | Destination |
| --- | --- | --- |
| Header | `Try PayOps` | `/try` |
| Merchant path | `Explore sample workspace` | `/try` |
| Final homepage section | `See PayOps in action` | `/try` |
| Developer path | `Developer quickstart` | `/docs/quickstart` |
| Optional support | `Ask a question` | Existing question issue URL |

Public surfaces must not describe the entry as a pilot, beta, application,
invitation, or request for access. GitHub remains available for source,
questions, and issues, but it is not the product's primary conversion path.

## Experience Architecture

The new `/try` route contains two isolated modes.

### Sample workspace

The default mode runs from deterministic, bundled PayOps fixtures. It does not
depend on authentication, PostgreSQL, the hosted API, a worker, or Solana RPC.
It presents a realistic read-only operations workspace with invoices, matched
payments, exceptions, and evidence.

The sample workspace is intentionally separate from `/operations`. The existing
operations route loads organization-scoped data and includes authenticated
mutations, incident controls, and production authority. Exposing it as a demo
would weaken those boundaries and create misleading controls.

### Public wallet

The secondary mode accepts a Solana public address and a bounded 7-day or
30-day date range. A narrowly scoped, rate-limited API reads public Solana data
and returns supported USDC and USDT transfer facts plus the checks PayOps can
perform from those facts.

Visitors may optionally provide an expected asset, amount, recipient, and
reference. Those expectations allow PayOps to compare a selected transfer with
the visitor's stated payment expectation. Without them, the result is transfer
verification, not invoice reconciliation.

The form never asks the visitor to connect a wallet. The analysis result remains
temporary browser state and does not create an organization, invitation,
session, merchant wallet, invoice, or durable operations record.

## Data Flow

```text
Try PayOps
├── Sample workspace
│   └── bundled fixtures → deterministic demo model → read-only workspace
└── Public wallet
    └── validated address and date range → rate-limited analysis API
        → read-only Solana RPC → supported transfer facts
        → optional expectation checks → temporary browser result
```

The sample model must have one canonical source of truth. Components consume a
typed view model rather than importing fixture files or reconstructing statuses
independently.

The public analysis API must return bounded, product-safe error codes. Raw RPC
responses and provider errors must not pass through to the browser or logs.

## Sample Workspace Screen

The first render is populated and useful. It contains:

- A persistent `Sample data` badge and a short explanation that the activity is
  realistic but synthetic.
- A dismissible three-step guide: inspect a matched payment, review an
  exception, and open its evidence.
- Summary metrics for invoices, matched payments, exceptions, and finalized
  volume.
- A payment list containing realistic synthetic addresses, references, token
  amounts, timestamps, and signatures.
- A detail panel that explains the selected decision through `Detect`,
  `Verify`, `Match`, and `Prove`.
- A secondary `Use a public wallet` action.

The guide draws attention to useful controls but never blocks free exploration.
Sample labeling remains visible after the guide is dismissed.

## Public-Wallet Screen

The public-wallet mode starts with a compact form containing:

- Solana public address.
- Date-range preset: 7 days or 30 days.
- Optional expected asset, amount, recipient, and reference.

The safety disclosure appears beside the form and remains visible in results:

> PayOps reads public blockchain data only. Never enter a seed phrase or
> private key. Invoice matching requires payment expectations that are not
> available from the blockchain alone.

Results separate three concepts:

1. Facts observed from public chain data.
2. Verification checks PayOps performed.
3. Expectation matching that was or was not possible.

The UI must not display `matched`, `reconciled`, or `invoice paid` when required
expectations were not supplied.

## States and Error Handling

- **Invalid address:** Explain the required public-address format and preserve
  the other entered values.
- **Invalid expectation:** Identify the specific asset, amount, recipient, or
  reference problem without clearing the form.
- **No supported transfers:** State that no canonical USDC or USDT transfers
  were found in the selected range and offer the sample workspace.
- **Unsupported token:** Explain the current USDC and USDT boundary.
- **Partial coverage:** Keep a persistent warning with the result; never present
  incomplete coverage as zero activity.
- **RPC unavailable:** Describe the failure as temporary and do not imply that
  the wallet has no activity.
- **Rate limited:** State when the visitor can retry.
- **Unexpected failure:** Show a bounded generic message and a request ID when
  available.

Sample mode remains functional when the live-analysis endpoint is unavailable.
The `Use a public wallet` control is enabled in production only when that
endpoint is deployed and healthy. The product must not expose a dead or
placeholder primary action.

## Accessibility and Responsive Behavior

- All mode controls, guides, rows or cards, drawers, and form fields are usable
  by keyboard.
- Submission moves focus to the first error or the results heading.
- Loading and completion changes are announced through appropriate live
  regions.
- Status never depends on color alone.
- Focus indicators remain visible against the dark PayOps theme.
- Desktop payment tables become stacked payment cards on narrow screens rather
  than introducing horizontal page overflow.
- Motion respects `prefers-reduced-motion` and does not block access to content.
- Sample and live-data disclosures use text, not icons alone.

## Security and Privacy Boundaries

- Accept only syntactically valid Solana public addresses and bounded date
  ranges before contacting RPC.
- Apply per-client and aggregate rate limits to public analysis.
- Bound transaction count, response size, provider time, and total request time.
- Use configured read-only RPC credentials only on the server.
- Never request or accept seed phrases, private keys, signatures, or wallet
  connections.
- Never log raw credentials, unbounded provider errors, or full attacker-
  controlled payloads.
- Do not persist public-wallet analysis by default.
- Do not share authentication cookies or organization permissions with the
  public analysis endpoint.
- Preserve explicit partial-coverage and uncertainty indicators.

## Testing Strategy

### Unit tests

- Deterministic fixture-to-demo-model conversion.
- Sample metrics and selected-decision evidence.
- Public-address and date-range validation.
- Optional expectation validation and result terminology.
- Provider-error to safe-product-error mapping.

### Component tests

- Every former pilot CTA points to `/try` with approved copy.
- Sample disclosures remain visible after guide dismissal.
- Sample workspace renders matched and exception states from the typed model.
- Public-wallet results distinguish observed, verified, and matched facts.
- Empty, partial, unavailable, unsupported, and rate-limited states preserve
  useful recovery actions.

### API tests

- Public analysis requires no session and cannot access organization routes.
- Invalid input is rejected before RPC access.
- Rate limits are enforced.
- Response and time bounds are enforced.
- RPC failures and partial coverage produce distinct safe responses.
- No unsupported token is reported as verified.

### End-to-end tests

- A new visitor reaches and explores the sample workspace in one click.
- The guided sample path opens a matched payment, an exception, and evidence.
- Stubbed public-wallet analysis covers successful, empty, partial, failed, and
  rate-limited responses.
- Desktop and mobile layouts avoid horizontal page overflow.
- Automated accessibility scans report no serious or critical violations.

## Rollout

1. Build and verify `/try` with the complete sample workspace.
2. Replace public pilot CTAs only after the sample route passes production
   smoke testing.
3. Deploy the public-wallet analysis API with RPC, timeout, size, and rate-limit
   controls.
4. Enable `Use a public wallet` only after the live endpoint passes readiness
   checks.
5. Keep sample mode operational during live-analysis degradation.
6. Update README, deployment, and website language to describe self-serve
   exploration accurately while retaining production-operation requirements.

The rollout may use separate reviewable changes, but no change may leave a
public CTA pointing to an unavailable destination.

## Acceptance Criteria

- A visitor can open sample PayOps data from the homepage without signup or
  contact.
- The visitor can inspect a matched payment, an exception, and evidence.
- The visitor can always tell whether data is synthetic or public-chain data.
- A visitor can submit a public wallet without connecting it or sharing secret
  material.
- Public-wallet output does not claim invoice matching without expectations.
- Live-analysis failure does not break the sample workspace.
- No public merchant CTA opens a pilot application or prefilled GitHub issue.
- Existing authenticated operations and production-control boundaries remain
  unchanged.

## Success Definition

The release succeeds when a person who receives the PayOps URL can understand
and exercise the product independently: one click reveals a realistic payment
decision, evidence can be inspected without an account, and optional public
wallet activity can be analyzed without contacting the team or granting wallet
authority.
