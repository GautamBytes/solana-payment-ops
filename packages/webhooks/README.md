# @payops/webhooks

Transactional lifecycle events with signed, retryable HTTPS delivery. Event
creation commits atomically with reconciliation decisions. Requires Node.js
22.18+ and PostgreSQL 16.

```bash
npm install @payops/webhooks@0.1.1
export DATABASE_URL=postgres://user:password@localhost:5432/payops
export MERCHANT_WEBHOOK_SECRET='replace-with-a-random-secret'
```

```bash
npx payops-webhooks migrate
npx payops-webhooks endpoint add \
  --id merchant-production \
  --url https://merchant.example/webhooks/payops \
  --secret-env MERCHANT_WEBHOOK_SECRET
npx payops-webhooks deliver --limit 64 --concurrency 8
```

Requests include event ID, delivery ID, timestamp, and an HMAC-SHA256 signature
over `<timestamp>.<exact raw body>`. Consumers must verify the untouched body
before parsing and deduplicate by event ID before applying side effects. A
framework-neutral verifier is exported as
`@payops/webhooks/consumer-example`.

Delivery is at least once. Automatic retries are bounded by attempt and age
limits. Production endpoints require canonical HTTPS on port 443; every DNS
answer is checked against blocked address ranges and the accepted address is
pinned for TLS delivery. Secrets, RPC responses, and unnecessary customer data
are excluded from payloads and inspection output.

[Source, consumer example, operator documentation, and license](https://github.com/payops-labs/solana-payment-ops)
