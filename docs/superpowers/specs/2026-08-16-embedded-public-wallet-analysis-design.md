# Embedded public wallet analysis design

## Context

PR #22 exposes the public wallet form, but the hosted Vercel project does not
run the full PayOps API. The full API intentionally requires PostgreSQL role
separation, a worker, and two RPC providers. Those controls remain the target
for merchant operations, but they are unnecessary for a bounded, read-only
public-chain demonstration.

## Decision

Add an optional same-origin Next.js route at `/v1/public-wallet-analysis`.
The route reuses `@payops/ingestion` for deterministic transaction parsing and
verification, and uses a server-only Solana RPC URL. It is enabled separately
from the full API so production operators cannot activate it accidentally.

The browser uses a relative URL in embedded mode. Existing deployments may
still provide `NEXT_PUBLIC_PAYOPS_API_ORIGIN` to call the full API.

## Security and privacy

- Accept only same-origin browser POST requests with JSON bodies up to 2 KiB.
- Parse exact request keys and canonical Solana addresses before any RPC work.
- Support only 7-day and 30-day windows and canonical mainnet USDC and USDT.
- Inspect at most 40 signatures and 20 transactions with concurrency 2.
- Abort all upstream work after 20 seconds and return only stable error codes.
- Set `Cache-Control: no-store`; never log or persist wallet addresses or results.
- Protect `/v1/public-wallet-analysis` with a Vercel WAF per-IP rate limit before
  enabling the embedded route on a public deployment.
- Keep RPC URLs server-side. No seed phrase, private key, signature, or wallet
  connection is requested.

## Availability

The web readiness route accepts one of two valid modes:

1. Full API mode: exact web and API origins are configured and API readiness
   succeeds.
2. Embedded mode: the embedded feature flag and a secure Solana RPC URL are
   configured.

Embedded analysis may return partial coverage when public RPC limits or the
bounded scan prevent a complete 7-day or 30-day history. The UI already marks
partial coverage explicitly.

## Cost boundary

This design uses the existing Vercel Hobby allocation and Solana's public
mainnet RPC endpoint. It creates no paid service, subscription, database, or
always-on process. If usage exceeds free platform limits, the demo may pause or
return an unavailable response rather than incur an application-level charge.

## Verification

- Unit tests cover configuration, exact input validation, same-origin checks,
  safe errors, bounded analyzer options, and relative client requests.
- Browser tests cover the wallet form against the deterministic fixture API.
- A hosted smoke submits a valid public address and verifies a schema `0.1`
  response without printing the address or response body.
- The full workspace check and GitHub PR checks must pass before merge.
