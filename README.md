# Solana Payment Operations

Solana Payment Operations (PayOps) is an Apache-2.0 payment-integrity and
reconciliation project. PayOps Core turns raw Solana transaction data into
deterministic, inspectable payment verification reports that invoice systems,
commerce products, and accounting tools can build on.

## Try PayOps

The product website includes a self-serve `/try` workspace with realistic,
synthetic invoices, payment decisions, exceptions, and evidence. It requires no
account, wallet connection, application, or approval. When operators enable the
optional public-wallet analysis, anyone can inspect bounded, read-only finalized
USDC or USDT activity for a public address. PayOps never asks users to connect,
sign, or provide a seed phrase or private key. The published open-core packages
and self-hosted production stack remain separate deployment choices.

## Why this exists

A successful transaction signature is not enough to mark an invoice paid.
Applications must verify finality, token identity, recipient ownership, exact
integer amounts, reference accounts, and transaction-wide balance changes.
PayOps packages those checks into an open conformance contract and a durable
ingestion engine instead of making every Solana team rebuild them
independently.

## Project status

The [project status](PROJECT_STATUS.md) links shipped capabilities, current
boundaries, active engineering work, and measurable next milestones to public
evidence. The [product walkthrough](docs/project-walkthrough.md) shows the
complete user and developer surface. Dated local
[backup-restore](deploy/drills/2026-08-17-backup-restore.md) and
[incident-response](deploy/drills/2026-08-17-incident-response.md) records show
how the operating procedures are exercised.

## Open Core v0.1

PayOps v0.1.1 publishes seven Apache-2.0 packages to npm. Every package is built
from the tagged source, verified as a clean consumer artifact, and published
through npm trusted publishing with provenance.

| Package                                                                              | Use it for                                              | Install                                    |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------- | ------------------------------------------ |
| [`@payops/contracts`](https://www.npmjs.com/package/%40payops%2Fcontracts)           | Lifecycle types, runtime parsing, and JSON Schemas      | `npm install @payops/contracts@0.1.1`      |
| [`@payops/core`](https://www.npmjs.com/package/%40payops%2Fcore)                     | Solana transaction parsing and payment verification     | `npm install @payops/core@0.1.1`           |
| [`@payops/ingestion`](https://www.npmjs.com/package/%40payops%2Fingestion)           | Durable RPC ingestion and finality tracking             | `npm install @payops/ingestion@0.1.1`      |
| [`@payops/webhooks`](https://www.npmjs.com/package/%40payops%2Fwebhooks)             | Transactional signed delivery and consumer verification | `npm install @payops/webhooks@0.1.1`       |
| [`@payops/reconciliation`](https://www.npmjs.com/package/%40payops%2Freconciliation) | Deterministic invoice matching and exceptions           | `npm install @payops/reconciliation@0.1.1` |
| [`@payops/pilot`](https://www.npmjs.com/package/%40payops%2Fpilot)                   | Resumable, read-only merchant shadow audits             | `npm install @payops/pilot@0.1.1`          |
| [`@payops/sdk`](https://www.npmjs.com/package/%40payops%2Fsdk)                       | Typed, zero-retry merchant API access                   | `npm install @payops/sdk@0.1.1`            |

PayOps Core:

- supports canonical mainnet USDC and USDT through an exact allowlist;
- loads a versioned raw-RPC payment fixture;
- resolves static and address-table account metadata;
- decodes legacy SPL Token `TransferChecked` and balance-proven `Transfer`
  amounts as `bigint`;
- parses outer and CPI instruction coordinates into stable event IDs;
- extracts Solana Pay-style read-only reference accounts;
- verifies cluster, finality, token program, mint, recipient token account and
  owner, amount, decimals, references, self-transfer safety, and aggregate
  balance conservation;
- emits canonical JSON suitable for CI and integration conformance tests.

The ingestion package adds:

- captured-head `getSignaturesForAddress` backfills with overlapping cursors;
- oldest-first processing, immutable raw snapshots, and SHA-256 digests;
- PostgreSQL idempotency, advisory locks, retry records, and quarantines;
- normalized transfer and reference-account indexes;
- confirmed-to-finalized status tracking with bounded reversion evidence;
- a deterministic CLI for migrations, provider and watch setup, sync,
  finality, and inspection.

PayOps does not sign transactions, hold keys, send funds, or make compliance
claims.

The included transaction is a synthetic, structurally faithful version-0
conformance vector. Its purpose is deterministic parser and verifier testing;
it is not presented as a historical mainnet payment.

## Requirements

- Node.js 22.18 or newer
- pnpm 11.15.0

Package consumers may use npm, pnpm, or another Node package manager. pnpm is
required only for repository development.

## Hosted deployment

The hosted stack builds four immutable targets from one revision:
`payops-api`, `payops-worker`, `payops-web`, and the one-shot
`payops-migrate`. They run as numeric non-root users against separate database
capabilities. The hosted public experience provides a realistic sample
workspace and bounded read-only inspection of finalized public Solana wallet
activity. It does not provide custody, transaction signing, a compliance
service, or a contractual production SLA.

```bash
pnpm containers:build
pnpm containers:test
```

The smoke uses generated local credentials and TLS material, applies every
migration twice, verifies role separation and readiness, tests graceful worker
shutdown, and removes its exact Compose project. See the
[hosted deployment operator runbook](deploy/README.md) before deploying anywhere.

## Run

```bash
pnpm install
pnpm check
pnpm conformance fixtures/v0.1/manifest.json
```

A passing fixture exits with status `0`. A parsed payment that fails a
verification rule exits with status `1`. Invalid CLI usage or an invalid
fixture exits with status `2`.

The [ingestion quick start](packages/ingestion/README.md) runs the PostgreSQL
service and one-shot operator CLI locally.

The [reconciliation quick start](packages/reconciliation/README.md) imports
merchant invoice expectations, matches finalized USDC or USDT transfers, and
exports explicit allocation and exception results.

The [transactional webhook quick start](packages/webhooks/README.md) registers
HTTPS receivers, delivers signed lifecycle events, verifies consumers, rotates
secrets, and replays failed deliveries.

The [merchant shadow-audit runbook](packages/pilot/README.md) validates a
consented audit manifest, resumes historical ingestion and reconciliation, and
produces private plus redacted reports without signing or moving funds.

The [merchant API SDK guide](packages/sdk/README.md) covers merchant
organization setup, verified Solana settlement wallets, USDC/USDT customer
invoices, hosted checkout links, exact payment requests, and typed backend
integration. The hosted worker marks invoices paid only from finalized,
matching Solana transfer evidence.

The [open-core integration guide](docs/open-core/integration-guide.md) shows
how to install the packages, replay the bundled corpus, verify a payment intent,
and consume a signed lifecycle event. The
[architecture](docs/open-core/architecture.md),
[lifecycle contract](docs/open-core/lifecycle-contract.md),
[fixture authoring guide](docs/open-core/fixture-authoring.md), and
[security model](docs/open-core/security-model.md) define the v0.1 boundary.

PayOps complements the
[Solana Pay protocol](https://solana.com/docs/tools/solana-pay): Solana Pay
constructs wallet-compatible requests, while PayOps verifies and reconciles
the resulting chain evidence. Hosted quoting consumes
[Pyth Price Feeds](https://docs.pyth.network/price-feeds) with strict freshness,
confidence, peg, and cross-rate controls. The reusable Open Core v0.1 packages
remain independently usable without the hosted applications.

Production USD invoices quote directly from the validated stablecoin price.
Production EUR, GBP, and INR invoices additionally require an authenticated
commercial FX adapter configured with `PAYOPS_COMMERCIAL_FX_ENDPOINT` and
`PAYOPS_COMMERCIAL_FX_TOKEN`. The endpoint must return the exact normalized
`0.1` rate envelope accepted by `CommercialFiatRateAdapter`. Without it,
non-USD quoting fails closed; ECB data remains reference-only.

## What developers can build on it

- hosted invoice checkout and automatic payment matching (included);
- finalized-payment webhooks with evidence attached;
- wallet and treasury reconciliation;
- accounting exports and exception queues;
- protocol adapters that prove their payment output follows the same contract.

## Project policies

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and review requirements,
[SECURITY.md](SECURITY.md) for private vulnerability reporting,
[CHANGELOG.md](CHANGELOG.md) for release history, and the
[release runbook](release/README.md) for the operator-controlled publication
process.

## License

Apache-2.0.
