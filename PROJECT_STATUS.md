# PayOps project status

Updated 2026-08-19.

PayOps is an Apache-2.0 Solana payment-integrity and reconciliation project. It
turns finalized transaction data into deterministic payment decisions that a
commerce product, operations team, or finance system can inspect and replay.

## The problem

A confirmed signature does not prove which invoice was paid. A payment system
must verify finality, token identity, recipient ownership, exact integer amount,
reference accounts, and transaction-wide balance movement before it changes
business state. PayOps performs those checks once and preserves the resulting
decision as evidence. Missing or conflicting facts become explicit exceptions
instead of guessed matches.

The [architecture](docs/open-core/architecture.md), [lifecycle
contract](docs/open-core/lifecycle-contract.md), and [security
model](docs/open-core/security-model.md) define the system boundary.

## Available now

- [Open Core v0.1.1](https://github.com/payops-labs/solana-payment-ops/releases/tag/v0.1.1)
  publishes seven npm packages for contracts, verification, ingestion,
  webhooks, reconciliation, merchant operations, and typed integration.
- The [v0.1 conformance corpus](fixtures/v0.1/manifest.json) contains 25
  deterministic cases covering matched payments and failure boundaries.
- The public `/try` workspace presents realistic synthetic invoices, a matched
  payment, wrong-destination and amount-mismatch exceptions, and preserved
  evidence without an account or wallet connection.
- Optional public-wallet inspection analyzes bounded, read-only finalized USDC
  and USDT activity. It never asks for a signature, seed phrase, or private key.
- Hosted checkout creates an exact payment request with token, recipient,
  amount, reference, expiry, and observable payment state.
- The operations surface exposes invoice decisions, reviewable exceptions,
  evidence packs, signed lifecycle events, readiness, and operator actions.
- Four immutable container targets separate API, worker, web, and migration
  responsibilities. The [operator runbook](deploy/README.md) covers deployment,
  upgrades, recovery, secret rotation, and incident control.
- CI runs formatting, linting, types, tests, builds, dependency review, CodeQL,
  and a production-like container smoke check. See the
  [CI workflow](.github/workflows/ci.yml).

The [complete product walkthrough](docs/project-walkthrough.md) connects these
surfaces in one payment story.

## Current boundaries

- Verification supports canonical mainnet USDC and USDT under the legacy SPL
  Token Program. Token-2022 is not supported yet.
- PayOps does not custody funds, sign transactions, provide compliance
  decisions, or promise a contractual service level.
- The public Vercel experience is a demonstration surface. The complete
  merchant operations stack is self-hosted through the container deployment.
- Production EUR, GBP, and INR quoting requires a configured commercial FX
  adapter. USD stablecoin quoting can fail closed without that dependency.

## Active engineering work

- Keep backup-restore and incident-response procedures executable and publish
  dated, bounded drill records.
- Support independent public integrations that exercise the package and API
  contracts outside this repository.

## Next milestones

1. Add Token-2022 verification and conformance cases. Completion means the
   parser, verifier, fixtures, security model, and release notes cover the new
   program without weakening legacy-token checks.
2. Publish three maintained reference integrations. Completion means each
   example has an owner, pinned dependencies, automated tests, and a documented
   upgrade path.
3. Complete an independent security review. Completion means findings and
   remediations are tracked publicly when disclosure is safe.
4. Release v0.2. Completion means tagged packages, provenance, compatibility
   notes, migration guidance, and the complete release verification gate are
   available.

Progress is tracked on the public [roadmap](https://solanapayops.xyz/roadmap)
and in [roadmap issues](https://github.com/payops-labs/solana-payment-ops/issues?q=is%3Aissue+label%3Aroadmap).

## Operational evidence

- [Backup and restore checklist](deploy/checklists/backup-restore.md)
- [Incident checklist](deploy/checklists/incident.md)
- [Dated local backup-restore drill](deploy/drills/2026-08-17-backup-restore.md)
- [Dated local incident-response drill](deploy/drills/2026-08-17-incident-response.md)
- [Release process](release/README.md)
- [Security policy](SECURITY.md)

Operational records use generated credentials, synthetic data, bounded output,
and disposable local infrastructure. They document the exact procedure tested
without presenting a local exercise as a hosted production result.
