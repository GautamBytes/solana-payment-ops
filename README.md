# Solana Payment Operations

Solana Payment Operations (PayOps) is an Apache-2.0 payment-integrity and
reconciliation project. PayOps Core turns raw Solana transaction data into
deterministic, inspectable payment verification reports that invoice systems,
commerce products, and accounting tools can build on.

## Why this exists

A successful transaction signature is not enough to mark an invoice paid.
Applications must verify finality, token identity, recipient ownership, exact
integer amounts, reference accounts, and transaction-wide balance changes.
PayOps packages those checks into an open conformance contract instead of
making every Solana team rebuild them independently.

## Current vertical slice

The first release:

- supports canonical mainnet USDC and USDT through an exact allowlist;
- loads a versioned raw-RPC payment fixture;
- resolves static and address-table account metadata;
- decodes legacy SPL Token `TransferChecked` amounts as `bigint`;
- parses outer and CPI instruction coordinates into stable event IDs;
- extracts Solana Pay-style read-only reference accounts;
- verifies cluster, finality, token program, mint, recipient token account and
  owner, amount, decimals, references, self-transfer safety, and aggregate
  balance conservation;
- emits canonical JSON suitable for CI and integration conformance tests.

It does not sign transactions, hold keys, send funds, call RPC providers, or
make compliance claims.

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
