# @payops/core

Deterministic Solana payment parsing and verification primitives for canonical
mainnet USDC and USDT. The package accepts versioned raw-RPC fixture data,
extracts legacy SPL Token `TransferChecked` events, and produces inspectable
finalized-payment conformance reports.

See the [PayOps repository](https://github.com/GautamBytes/solana-payment-ops)
for documentation, fixtures, roadmap, and source code.

## Conformance runner

Run one payment fixture or an ordered manifest:

```bash
payops-conformance fixtures/v0.1/usdc-transfer-checked-finalized.json
payops-conformance fixtures/v0.1/manifest.json
```

The manifest runner verifies each file's SHA-256 digest before JSON parsing,
rejects path and symlink escapes, caps inputs at 2 MiB, and emits stable
manifest and suite digests. Exit code `0` means all expectations matched, `1`
means a valid suite had an expectation mismatch, and `2` means the input was
invalid.

The npm package includes the complete corpus under `dist/fixtures/v0.1` and
exports its manifest as `@payops/core/fixtures/v0.1/manifest.json`. This lets a
consumer resolve and replay the exact release corpus without cloning PayOps.
