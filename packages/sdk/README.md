# @payops/sdk

Typed, zero-retry client for the PayOps merchant invoice API.

```ts
import { createPayOpsClient } from "@payops/sdk";

const payops = createPayOpsClient({
  baseUrl: "https://payops.example.com",
  apiKey: process.env.PAYOPS_API_KEY,
});

const invoice = await payops.createInvoice(input, {
  idempotencyKey: `invoice:${input.externalId}`,
});
```

## Merchant setup

An operator first creates a single-use bootstrap invitation. The invited owner accepts it from a trusted application origin:

```bash
curl https://payops.example.com/v1/auth/bootstrap/accept \
  -H 'content-type: application/json' \
  -H 'origin: https://merchant.example.com' \
  --data '{"token":"<invitation-token>","email":"owner@example.com","name":"Merchant Owner","password":"<strong-password>"}'
```

After email verification, sign-in, and TOTP enrollment, the owner can create an organization API key through Better Auth's session-authenticated endpoint:

```bash
curl https://payops.example.com/api/auth/api-key/create \
  -H 'content-type: application/json' \
  -H 'origin: https://merchant.example.com' \
  -H 'cookie: <session-cookie>' \
  --data '{"configId":"payops-organization","name":"merchant-backend","organizationId":"<organization-id>"}'
```

API keys are organization-scoped and intended for backend use.

## Wallet and invoice flow

```ts
const challenge = await payops.createWalletChallenge(solanaAddress);
// Sign challenge.message using the same Solana address.
const wallet = await payops.registerMerchantWallet(
  {
    challengeId: challenge.id,
    nonce: challenge.nonce,
    signature,
    acceptedAssetSymbols: ["USDC", "USDT"],
  },
  { idempotencyKey: `wallet-registration:${challenge.id}` },
);

const customer = await payops.createCustomer(
  { externalId: "customer-42", displayName: "Example Buyer" },
  { idempotencyKey: "customer:create:42" },
);

const draft = await payops.createInvoice(
  {
    externalId: "order-42",
    customerId: customer.id,
    settlementWalletId: wallet.id,
    acceptedAssetSymbols: ["USDC", "USDT"],
    currency: "USD",
    dueAt: "2026-09-01T00:00:00.000Z",
    lines: [
      {
        description: "Consulting",
        quantity: "1",
        unitPriceMinorUnits: "25000",
        taxMinorUnits: "0",
      },
    ],
  },
  { idempotencyKey: "invoice:order-42" },
);

const issued = await payops.issueInvoice(draft.id, {
  idempotencyKey: "invoice:order-42:issue",
});
const page = await payops.listInvoices({ status: "issued", limit: 25 });
```

Catch `PayOpsApiError` to handle stable `status`, `code`, and `requestId` fields without logging credentials or raw response bodies.

Every mutation that can create a durable effect requires an explicit idempotency key. The client does not automatically retry requests, so callers retain control over payment-adjacent side effects. Requests have a 10-second default timeout and accept an `AbortSignal`.

The API key is server-side credential material. Do not embed it in a browser or mobile application.

PR 7 manages merchant wallets, customers, and invoice issuance. Hosted checkout links and automatic Solana payment detection arrive in PR 8; this SDK does not yet create payment requests or mark invoices paid.
