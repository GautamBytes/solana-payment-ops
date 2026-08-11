# Solana Payment Operations

Solana Payment Operations (PayOps) is an Apache-2.0 payment-integrity and
reconciliation project. PayOps Core turns raw Solana transaction data into
deterministic, inspectable payment verification reports that invoice systems,
commerce products, and accounting tools can build on.

## Why this exists

A successful transaction signature is not enough to mark an invoice paid.
Applications must verify finality, token identity, recipient ownership, exact
integer amounts, reference accounts, and transaction-wide balance changes.
PayOps packages those checks into an open conformance contract and a durable
ingestion engine instead of making every Solana team rebuild them
independently.

## Open Core v0.1

The release contains six installable Apache-2.0 packages:

- `@payops/contracts`: strict lifecycle contracts and JSON Schemas;
- `@payops/core`: Solana transaction parsing, verification, and 25 fixtures;
- `@payops/ingestion`: durable RPC ingestion and finality tracking;
- `@payops/reconciliation`: deterministic invoice matching and exceptions;
- `@payops/webhooks`: transactional signed webhook delivery and verification;
- `@payops/pilot`: resumable, read-only merchant shadow audits.

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
consented pilot manifest, resumes historical ingestion and reconciliation, and
produces private plus grant-safe reports without signing or moving funds.

The [merchant API SDK guide](packages/sdk/README.md) covers invitation-only
organization setup, verified Solana settlement wallets, USDC/USDT customer
invoices, idempotent issuance, and typed backend integration. Hosted checkout
and automatic payment detection remain the next product slice.

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
the resulting chain evidence. Future hosted quoting may consume
[Pyth Price Feeds](https://docs.pyth.network/price-feeds); no oracle or quote
logic is part of Open Core v0.1.

## What developers can build on it

- hosted invoice checkout and automatic payment matching;
- finalized-payment webhooks with evidence attached;
- wallet and treasury reconciliation;
- accounting exports and exception queues;
- protocol adapters that prove their payment output follows the same contract.

## Design and roadmap

The complete product, grant case, architecture, security model, milestones, and
success metrics are in the
[product specification](docs/superpowers/specs/2026-08-06-solana-payment-ops-design.md).
The first implementation slice is tracked in the
[core plan](docs/superpowers/plans/2026-08-06-payops-core-vertical-slice.md).

## License

Apache-2.0.
