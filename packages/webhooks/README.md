# PayOps transactional webhooks

`@payops/webhooks` turns committed PayOps reconciliation decisions into signed,
retryable HTTPS requests. Event creation participates in the reconciliation
database transaction, so an invoice allocation or exception cannot commit
without its lifecycle event.

## Operator quick start

Set `DATABASE_URL`, run migrations, and register a public HTTPS receiver. The
database stores the environment-variable name, never its secret value. The
referenced variable must be present when an endpoint is added or rotated.

```bash
export DATABASE_URL=postgres://payops:payops@localhost:5432/payops
export MERCHANT_WEBHOOK_SECRET='replace-with-a-random-secret'

pnpm --filter @payops/webhooks build
pnpm --filter @payops/webhooks exec payops-webhooks migrate
pnpm --filter @payops/webhooks exec payops-webhooks endpoint add \
  --id merchant-production \
  --url https://merchant.example/webhooks/payops \
  --secret-env MERCHANT_WEBHOOK_SECRET
pnpm --filter @payops/webhooks exec payops-webhooks endpoint list
```

Run delivery as a one-shot cron or supervisor job. A limit must be an integer
from 1 through 256.

```bash
payops-webhooks deliver --limit 64 --concurrency 8
```

`--concurrency` is optional, defaults to 8, and accepts integers from 1 through 32. It limits simultaneous network requests within that one batch; `--limit`
still caps the total number of deliveries claimed.

Inspect an event and its delivery attempts without printing the payload body:

```bash
payops-webhooks inspect event --id <event-uuid>
```

Replay a succeeded, dead, or waiting delivery. Replay preserves the event ID,
the exact payload bytes, and prior attempt history. It performs one manual
attempt; it does not silently create a new automatic retry stream.

```bash
payops-webhooks delivery replay --id <delivery-uuid>
```

## Signing and consumer verification

Requests include `PayOps-Event-Id`, `PayOps-Delivery-Id`, `PayOps-Timestamp`,
and `PayOps-Signature`. The signature is `v1=` followed by the hexadecimal
HMAC-SHA256 of `<timestamp>.<exact raw body>`. Verify the untouched request
body and the five-minute replay window before parsing JSON. Then deduplicate
with a unique database constraint on the event ID before applying a side
effect. Custom verification tolerances must be finite and non-negative and
cannot exceed one hour; invalid verifier clocks or tolerances fail closed.

[`src/examples/verify-consumer.ts`](src/examples/verify-consumer.ts) contains the
readable framework-neutral implementation, including verification-before-parse
and idempotent event handling. Its in-memory ID set is deliberately an example,
not production persistence. The same implementation is compiled and exported
as `@payops/webhooks/consumer-example`.

### Secret rotation

Introduce a new variable without deleting the old one, then rotate the endpoint:

```bash
export MERCHANT_WEBHOOK_SECRET_V2='another-random-secret'
payops-webhooks endpoint rotate-secret \
  --id merchant-production \
  --secret-env MERCHANT_WEBHOOK_SECRET_V2
```

The endpoint retains the previous variable name for receiver-side overlap.
PayOps signs new deliveries with the current secret. Remove the old secret only
after every receiver has switched.

## Delivery semantics and network policy

Delivery is at least once. A receiver can accept a request immediately before a
worker loses its lease or process, so duplicate HTTP requests are expected.
Success is any 2xx response. Network errors, 408, 425, 429, and 5xx responses
retry with bounded backoff; other 4xx responses become dead. Automatic retries
continue until the 72-hour age ceiling.

Production endpoints must use canonical HTTPS on port 443 without credentials,
fragments, redirects, or ambiguous URL syntax. Registration rejects unsafe
literal addresses and host syntax. On every delivery attempt, PayOps resolves a
hostname, rejects the entire answer set if any address is loopback, private,
link-local, carrier-grade NAT, documentation, multicast, unspecified, or
cloud-metadata space, and pins one validated address for the TLS connection.

## Event contract

Event envelopes use `schemaVersion` `0.1`, a stable UUID `id`, `type`,
`occurredAt`, `statusAtOccurrence`, a versioned `object`, and event-specific
`data`. String limits count Unicode code points, matching PostgreSQL
`char_length` semantics.

The initial event vocabulary is `invoice.issued`, `payment.detected`,
`payment.confirmed`, `payment.finalized`, `payment.confirmation_revoked`,
`payment.exception_created`, `invoice.partial`, `invoice.paid`,
`invoice.overpaid`, `refund.prepared`, `refund.finalized`, and
`evidence.ready`. Event variants without a detailed producer in this package
currently use an empty `data` object and rely on the common envelope fields.

- `invoice.paid` identifies the invoice and customer, stable Solana event ID,
  transaction signature, instruction coordinates, mint, exact base-unit amount,
  and reconciliation rule version.
- `payment.exception_created` identifies the optional invoice, stable Solana
  event and transaction coordinates, exact base-unit amount, exception
  code, rule version, and review state.

Payloads exclude endpoint secrets, provider URLs, raw RPC responses, and
unnecessary customer data.
