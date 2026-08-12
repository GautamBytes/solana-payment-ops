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
const checkout = await payops.createCheckoutLink(issued.invoice.id);
// Send checkout.checkoutUrl to the customer. The raw URL is a capability:
// do not log it or place it in analytics.

// A merchant backend can also create the exact request directly.
const attempt = await payops.createPaymentAttempt(issued.invoice.id, {
  assetSymbol: "USDC",
});
const page = await payops.listInvoices({ status: "issued", limit: 25 });
```

Catch `PayOpsApiError` to handle stable `status`, `code`, and `requestId` fields without logging credentials or raw response bodies.

Invoice, customer, and wallet mutations require an explicit idempotency key. Checkout-link creation deterministically returns the active link; payment-attempt creation fails with `409` while an active attempt exists. The client never automatically retries requests, so callers retain control over payment-adjacent side effects. Requests have a 10-second default timeout and accept an `AbortSignal`.

The API key is server-side credential material. Do not embed it in a browser or mobile application.

Hosted checkout links expose only minimized invoice data. PayOps creates exact USDC or USDT Solana Pay requests, tracks detected/confirmed/finalized states, and marks the invoice paid only from finalized matching transfer evidence.
