# @payops/sdk

Typed, zero-retry backend client for the PayOps merchant invoice API. Requires
Node.js 22.18 or newer.

```bash
npm install @payops/sdk@0.1.0
```

```ts
import { createPayOpsClient } from "@payops/sdk";

const payops = createPayOpsClient({
  baseUrl: "https://payops.example.com",
  apiKey: process.env.PAYOPS_API_KEY,
});

const invoice = await payops.createInvoice(input, {
  idempotencyKey: `invoice:${input.externalId}`,
});

const issued = await payops.issueInvoice(invoice.id, {
  idempotencyKey: `invoice:${input.externalId}:issue`,
});
```

Wallet, customer, invoice, and payment mutations require explicit idempotency
keys. The client never retries automatically, so callers retain control over
payment-adjacent side effects. `PayOpsApiError` exposes bounded `status`,
`code`, and `requestId` fields without credentials or raw response bodies.

API keys and session cookies are server-side credentials. Never embed them in
browser or mobile applications, logs, or analytics.

[Source, API documentation, examples, and license](https://github.com/GautamBytes/solana-payment-ops)
