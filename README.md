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

## Current implementation

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
pnpm conformance fixtures/v0.1/usdc-transfer-checked-finalized.json
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
