# @payops/core

Deterministic, offline Solana payment parsing and verification for canonical
mainnet USDC and USDT. Requires Node.js 22.18 or newer.

```bash
npm install @payops/core@0.1.0
```

Run a fixture or the complete ordered conformance corpus:

```bash
npx payops-conformance ./payment-fixture.json
npx payops-conformance ./node_modules/@payops/core/dist/fixtures/v0.1/manifest.json
```

The runner verifies manifest digests before parsing, rejects path and symlink
escapes, caps inputs, and emits stable suite digests. Exit codes are `0` for a
match, `1` for an expectation mismatch, and `2` for invalid input.

This package does not schedule RPC requests or persist invoices.

[Source, fixtures, documentation, and license](https://github.com/GautamBytes/solana-payment-ops)
