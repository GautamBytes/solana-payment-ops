export type DocSection = {
  readonly title: string;
  readonly body: readonly string[];
  readonly code?: string;
  readonly callout?: string;
};

export type DocPage = {
  readonly slug: string;
  readonly label: string;
  readonly title: string;
  readonly summary: string;
  readonly readingTime: string;
  readonly sections: readonly DocSection[];
};

export const docPages: readonly DocPage[] = [
  {
    slug: "quickstart",
    label: "Quickstart",
    title: "Start reconciling Solana payments",
    summary:
      "Install the SDK, define an invoice, and turn a finalized USDC or USDT transfer into a deterministic payment decision.",
    readingTime: "5 min",
    sections: [
      {
        title: "Install the packages",
        body: [
          "Use the SDK for the product-facing client and core for deterministic verification and reconciliation.",
        ],
        code: "npm install @payops/sdk @payops/core",
      },
      {
        title: "Define the invoice",
        body: [
          "Store the expected mint, recipient, exact amount, and invoice reference before asking PayOps to reconcile a transfer.",
          "PayOps supports finalized Solana Mainnet USDC and USDT payments. It never signs transactions or takes custody of funds.",
        ],
        callout:
          "Start read-only: replay historical payments before connecting the result to production invoice state.",
      },
      {
        title: "Reconcile and keep the evidence",
        body: [
          "A clean match closes the invoice and emits a signed lifecycle event. Anything ambiguous becomes an exception for human review.",
        ],
        code: 'const decision = reconcilePayment({ invoice, transfer });\nif (decision.kind === "paid") await saveEvidence(decision);',
      },
    ],
  },
  {
    slug: "integration",
    label: "Integration",
    title: "Integrate PayOps into your product",
    summary:
      "Connect invoice creation, finalized Solana ingestion, deterministic reconciliation, and signed lifecycle events without handing PayOps a private key.",
    readingTime: "9 min",
    sections: [
      {
        title: "Choose your integration boundary",
        body: [
          "Use @payops/core inside your backend when you own ingestion and persistence. Use @payops/sdk when your product calls the PayOps API.",
        ],
        code: "npm install @payops/core",
      },
      {
        title: "Record exact payment expectations",
        body: [
          "Create each invoice with its token mint, settlement wallet, exact base-unit amount, customer reference, and expiry. Those values become the immutable comparison boundary.",
        ],
      },
      {
        title: "Verify before parsing",
        body: [
          "Webhook consumers must verify the HMAC against the raw request body before JSON parsing. Accept the current and previous secret during rotation, then deduplicate by event ID.",
        ],
        code: "const verified = verifyWebhook({ rawBody, signature, secret });\nif (!verified) return new Response(null, { status: 401 });",
        callout:
          "Return 2xx only after the event is durably accepted. PayOps retries temporary failures with a bounded schedule.",
      },
    ],
  },
  {
    slug: "architecture",
    label: "Architecture",
    title: "A payment pipeline built for evidence",
    summary:
      "PayOps separates chain ingestion, canonical transfer facts, reconciliation decisions, delivery, and operator review so every decision can be reproduced.",
    readingTime: "7 min",
    sections: [
      {
        title: "One-way evidence flow",
        body: [
          "Finalized Solana transactions become canonical transfer records. Reconciliation compares those records with immutable invoice expectations. The result is persisted with its evidence before any webhook is queued.",
        ],
        code: "Solana RPC → ingestion → canonical transfer\ninvoice + transfer → decision + evidence\ndecision → signed event → your system",
      },
      {
        title: "Deterministic decisions",
        body: [
          "Parser versions are explicit and ordered. Replaying the same canonical transfer and invoice produces the same outcome, while conflicting representations fail closed.",
        ],
      },
      {
        title: "Operational boundaries",
        body: [
          "Workers claim durable jobs with leases, delivery attempts are append-only, and stale workers cannot complete a reclaimed job. Review queues expose uncertainty instead of hiding it.",
        ],
      },
    ],
  },
  {
    slug: "lifecycle",
    label: "Lifecycle events",
    title: "Consume stable payment lifecycle events",
    summary:
      "Use a small, versioned event contract for paid invoices and payment exceptions, with canonical bytes and replay-safe identifiers.",
    readingTime: "6 min",
    sections: [
      {
        title: "Invoice paid",
        body: [
          "invoice.paid.v1 is emitted only after a finalized transfer exactly matches the expected mint, recipient, amount, and invoice reference.",
        ],
        code: '{\n  "schemaVersion": "0.1",\n  "type": "invoice.paid.v1",\n  "object": { "type": "invoice", "id": "inv_0421" }\n}',
      },
      {
        title: "Payment exception",
        body: [
          "payment.exception.v1 carries the review reason and the evidence needed to investigate. An exception never silently mutates invoice state.",
        ],
      },
      {
        title: "Replay safely",
        body: [
          "Deduplicate by event ID, persist before responding, and make downstream handlers idempotent. Manual replay preserves the same event and canonical payload bytes.",
        ],
      },
    ],
  },
  {
    slug: "security",
    label: "Security",
    title: "Security boundaries you can inspect",
    summary:
      "PayOps is read-only and non-custodial. It validates finalized chain data, fails closed on ambiguity, and signs outbound events without exposing secrets.",
    readingTime: "8 min",
    sections: [
      {
        title: "No custody, no signing",
        body: [
          "PayOps needs public settlement addresses and read-only Solana RPC access. It does not request seed phrases, private keys, or transaction-signing authority.",
        ],
      },
      {
        title: "Fail-closed reconciliation",
        body: [
          "Only finalized Mainnet transfers from supported token mints are eligible. Mismatched amounts, recipients, references, or representations become explicit exceptions.",
        ],
      },
      {
        title: "Safe webhook delivery",
        body: [
          "Endpoints are HTTPS-only. Delivery resolves and validates every DNS answer, pins the connection, preserves TLS hostname verification, blocks redirects, and signs the exact persisted body.",
        ],
        callout:
          "Rotate webhook secrets with an overlap window, then remove the previous secret after consumers have moved.",
      },
    ],
  },
  {
    slug: "packages",
    label: "Packages",
    title: "Use only the PayOps pieces you need",
    summary:
      "Seven focused npm packages cover contracts, core reconciliation, ingestion, storage, webhooks, SDK access, and reference fixtures.",
    readingTime: "5 min",
    sections: [
      {
        title: "Product integration",
        body: [
          "@payops/sdk is the typed API client. @payops/core contains deterministic domain logic. @payops/contracts defines the stable shared event and evidence contracts.",
        ],
        code: "npm install @payops/sdk @payops/contracts",
      },
      {
        title: "Infrastructure integration",
        body: [
          "@payops/ingestion records Solana transfer representations. @payops/reconciliation persists decisions. @payops/webhooks delivers signed events with bounded retries.",
        ],
      },
      {
        title: "Conformance",
        body: [
          "@payops/reference provides replayable fixtures and expected outcomes so integrations can prove they interpret the same payment facts the same way.",
        ],
      },
    ],
  },
  {
    slug: "api",
    label: "API reference",
    title: "Build against a typed merchant API",
    summary:
      "Create customers and invoices, manage settlement wallets, review exceptions, export evidence, and monitor production readiness through versioned HTTP endpoints.",
    readingTime: "10 min",
    sections: [
      {
        title: "Invoices and checkout",
        body: [
          "Create and issue invoices, generate public checkout links, inspect payment attempts, cancel unpaid invoices, and poll checkout status without exposing internal identifiers.",
        ],
        code: "POST /v1/invoices\nPOST /v1/invoices/{invoiceId}/issue\nGET  /pay/{checkoutToken}/status",
      },
      {
        title: "Exceptions and evidence",
        body: [
          "List reviewable payment exceptions, assign and resolve them through explicit state transitions, and download evidence packs or accounting exports.",
        ],
        code: "GET  /v1/exceptions\nPOST /v1/exceptions/{id}/resolve\nGET  /v1/evidence-packs/{invoiceId}",
      },
      {
        title: "Operations",
        body: [
          "Readiness, production controls, incident state, and promotion checks are exposed separately from merchant workflows.",
        ],
      },
    ],
  },
] as const;

export function getDocPage(slug: string) {
  return docPages.find((page) => page.slug === slug);
}
