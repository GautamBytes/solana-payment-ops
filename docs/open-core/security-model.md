# Security model

## Protected assets

PayOps protects payment classification, immutable chain evidence, invoice
allocation, lifecycle event identity, webhook authenticity, and release
artifact integrity. It does not hold or use merchant or payer private keys.

## Trust boundaries

- RPC responses are untrusted until schema validation, canonical archival,
  parser checks, and finality policy succeed.
- A transaction signature alone is never payment proof. Exact token program,
  mint, destination, owner, amount, decimals, reference, instruction identity,
  transaction success, balance delta, and finalized commitment are checked.
- PostgreSQL transactions and uniqueness constraints enforce durable
  idempotency. Process memory is not the financial source of truth.
- Webhook endpoints are HTTPS-only. Delivery resolves every DNS answer, rejects
  private or special-use addresses, pins the approved address for the request,
  preserves TLS hostname verification, disables redirects and proxy discovery,
  and bounds time, body size, attempts, and retry horizon.
- Consumers verify the signature over exact raw bytes before parsing and apply
  effects once under the verified event ID.
- Hosted checkout URLs are 256-bit capabilities. Only their SHA-256 digests
  are persisted; pages and API responses are private/no-store and suppress
  referrers. Operators must redact `/pay/<token>` paths from proxy logs.
- Production quotes require bounded, fresh Pyth observations with confidence,
  peg, and cross-rate divergence checks. Raw provider bodies are not retained.
- Release publication accepts only a clean, exact tag, a checked-in ordered
  bundle manifest, verified fixture and schema artifacts, authenticated npm
  scope ownership, and matching package bytes. A reused package version with
  different bytes is terminal.

## Explicit limits

Open Core v0.1 supports mainnet canonical USDC and USDT under the legacy SPL
Token Program. Token-2022 transfer evidence is rejected. Automatic allocation
uses finalized evidence; confirmed observations are provisional. The project
does not provide custody, sanctions screening, tax advice, regulatory
compliance, fiat conversion, or a production SLA. ECB observations are
reference-only and cannot authorize non-USD production quotes.

Report suspected vulnerabilities through GitHub private vulnerability
reporting. Do not open a public issue or include secrets, customer data,
credential-bearing RPC URLs, or undisclosed vulnerability details in a public
discussion.
