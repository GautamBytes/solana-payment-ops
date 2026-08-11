# Fixture authoring

The v0.1 corpus is synthetic and manifest-driven. Never add a partner RPC body,
customer identifier, API URL, secret, or private key.

Each case under `fixtures/v0.1/cases` is a complete raw-RPC envelope or an
intentional schema rejection. `manifest.json` fixes its order, kind, tags,
SHA-256 digest, event IDs, verification result, failed verification codes, and
reconciliation exception where applicable. The loader verifies exact bytes
before parsing and rejects duplicate files, path escapes, symlink escapes,
oversized files, and unknown tags.

To change the permanent corpus:

1. edit the test-only builder in
   `packages/core/test/support/generate-conformance-corpus.mjs`;
2. build contracts and core, then run that builder;
3. run `pnpm conformance fixtures/v0.1/manifest.json` twice;
4. run the core and reconciliation corpus tests; and
5. review every changed fixture and digest.

Stable signatures, addresses, slots, amounts, and instruction coordinates make
the suite digest reproducible. A change to bytes, order, or expectations is a
reviewable contract change, not incidental test churn.
