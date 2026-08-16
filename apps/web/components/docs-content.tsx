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
    readingTime: "10 min",
    sections: [
      {
        title: "Before you begin",
        body: [
          "PayOps is for teams that already receive USDC or USDT on Solana and need a dependable answer to a business question: which finalized transfer paid which invoice? It is reconciliation infrastructure, not a wallet, checkout processor, or custody service.",
          "For the safest first integration, use a copy of historical invoice expectations and finalized transfers. You can prove that PayOps reaches the same decisions as your team before any result is allowed to change production invoice state.",
        ],
        callout:
          "You need Node.js 22.18 or newer, a PostgreSQL database for durable workflows, read-only Solana RPC access, and at least one settlement wallet. Never provide a seed phrase or signing key.",
      },
      {
        title: "Install the packages",
        body: [
          "Use the SDK when your product calls a deployed PayOps merchant API. Use reconciliation when your operations backend imports invoice expectations, allocates finalized transfer evidence, and persists decisions in PostgreSQL. Contracts gives event producers and consumers one shared lifecycle envelope.",
          "Core is the offline parser and verifier for canonical Solana payment fixtures. It is useful for conformance and evidence checks, but it does not schedule RPC requests or persist invoices.",
        ],
        code: "# Product/API integration\nnpm install @payops/sdk @payops/contracts\n\n# Operated reconciliation backend\nnpm install @payops/ingestion @payops/reconciliation @payops/webhooks",
      },
      {
        title: "Define the invoice",
        body: [
          "Store the expected mint, recipient, exact amount, and invoice reference before asking PayOps to reconcile a transfer.",
          "Amounts are compared in integer base units, not floating-point display values. The supported mint and settlement recipient are explicit, and the invoice expectation is treated as immutable evidence after issue.",
        ],
        code: "invoice_id,customer_id,expected_mint,destination_token_account,amount_base_units,reference_address,issued_at,due_at\ninv-0421,customer-acme,<USDC_MINT>,<TOKEN_ACCOUNT>,1250000000,<REFERENCE>,<ISSUED_AT>,<DUE_AT>",
      },
      {
        title: "Record finalized transfer facts",
        body: [
          "Ingestion observes a finalized Solana transaction and records the transfer signature, instruction coordinates, mint, source, destination, exact amount, reference, slot, and parser version. PayOps keeps the canonical representation that the decision used.",
          "Finality is part of the eligibility rule. A processed or merely confirmed transaction is not promoted to an authoritative payment decision.",
        ],
      },
      {
        title: "Reconcile and keep the evidence",
        body: [
          "Reconciliation compares the finalized transfer with the invoice expectation. A paid decision requires the supported mint, settlement recipient, exact amount, reference, and network scope to agree. The decision and its evidence are persisted atomically before a lifecycle event is queued.",
          "Missing, conflicting, duplicated, or ambiguous facts do not become a guessed match. They become an explicit payment exception that an operator can investigate without silently changing the invoice.",
        ],
        code: "npx payops-reconciliation migrate\nnpx payops-reconciliation invoice import --file ./invoices.csv\nnpx payops-reconciliation reconcile run\nnpx payops-reconciliation report --format json",
      },
      {
        title: "Move from replay to production",
        body: [
          "Run the reference fixtures and a representative historical replay first. Compare paid decisions, exceptions, and evidence with your existing records. Investigate every difference instead of tuning the system to force a match.",
          "Then connect signed lifecycle events to a staging consumer, verify the raw request body before parsing, deduplicate by event ID, and acknowledge only after durable acceptance. Promote one settlement wallet or merchant cohort at a time and monitor exceptions before expanding scope.",
        ],
        callout:
          "A production rollout is ready when historical replay agrees, webhook retries are observable, secret rotation is tested, exception ownership is assigned, and the team can export evidence for a paid invoice.",
      },
    ],
  },
  {
    slug: "integration",
    label: "Integration",
    title: "Integrate PayOps into your product",
    summary:
      "Connect invoice creation, finalized Solana ingestion, deterministic reconciliation, and signed lifecycle events without handing PayOps a private key.",
    readingTime: "13 min",
    sections: [
      {
        title: "Choose the path that fits your team",
        body: [
          "Product teams can use @payops/sdk to create invoices, issue checkout links, inspect status, and consume typed API responses from a PayOps deployment. This keeps payment truth behind a service boundary and gives frontend and backend code a small integration surface.",
          "Platform teams that operate Solana ingestion, PostgreSQL, and workers use @payops/ingestion and @payops/reconciliation for the durable pipeline. Use @payops/core separately when you need offline transaction parsing, fixture verification, or conformance checks.",
        ],
        code: "# Service boundary\nnpm install @payops/sdk @payops/contracts\n\n# Operated backend\nnpm install @payops/ingestion @payops/reconciliation @payops/webhooks\n\n# Offline verification\nnpm install @payops/core",
      },
      {
        title: "Verify canonical payment evidence offline",
        body: [
          "@payops/core parses canonical Solana transaction fixtures and verifies the selected transfer against the fixture expectation. This is the right boundary for deterministic evidence checks and conformance, not durable invoice allocation.",
          "Parse the fixture and transfer through the package's public helpers, then call verifyPayment with the fixture, selected transfer, and all parsed transfers. The report contains the complete ordered checks and a single verified result.",
        ],
        code: 'import { verifyPayment } from "@payops/core";\n\nconst report = verifyPayment(fixture, selectedTransfer, allTransfers);\nif (!report.verified) throw new Error("payment evidence did not verify");',
      },
      {
        title: "Record exact payment expectations",
        body: [
          "Create each invoice with its token mint, settlement wallet, exact base-unit amount, customer reference, and expiry. Those values become the immutable comparison boundary.",
          "Do not derive an expected amount from a rounded UI value at reconciliation time. Persist the integer amount that was shown to the payer, and preserve a stable invoice ID separately from any human-readable reference.",
        ],
      },
      {
        title: "Connect read-only chain ingestion",
        body: [
          "Give the ingestion worker public settlement addresses and read-only RPC access. It should observe finalized Mainnet transactions, extract supported token transfers, and store their canonical representation with an explicit parser version.",
          "PayOps never needs transaction-signing authority. Keeping observation separate from wallet control reduces the blast radius of the reconciliation service and makes historical replay possible.",
        ],
      },
      {
        title: "Persist the decision before side effects",
        body: [
          "Treat the reconciliation decision, its evidence, the lifecycle event, and the first delivery record as one transactional boundary. Your invoice should not be marked paid while the evidence or event is missing.",
          "Repeated processing of the same canonical invoice and transfer is idempotent. A conflicting payload for an already reserved source identity fails closed instead of replacing history.",
        ],
      },
      {
        title: "Verify before parsing",
        body: [
          "Webhook consumers must verify the HMAC against the raw request body before JSON parsing. Accept the current and previous secret during rotation, then deduplicate by event ID.",
          "Validate the complete lifecycle envelope after signature verification. Unknown event types, malformed identifiers, unsupported schema versions, extra fields, and timestamps outside your accepted tolerance should be rejected before business logic runs.",
        ],
        code: "const verified = verifyWebhook({ rawBody, signature, secret });\nif (!verified) return new Response(null, { status: 401 });",
        callout:
          "Return 2xx only after the event is durably accepted. PayOps retries temporary failures with a bounded schedule.",
      },
      {
        title: "Roll out and operate the integration",
        body: [
          "Begin with historical replay, then staging, then a bounded production cohort. Track paid decisions, exceptions, webhook latency, retry exhaustion, and the age of the oldest unreviewed exception.",
          "Assign an owner for exception review and an owner for webhook delivery. Document how to rotate secrets, replay one event, pause delivery during an incident, and export an evidence pack when finance disputes a payment state.",
        ],
      },
    ],
  },
  {
    slug: "architecture",
    label: "Architecture",
    title: "A payment pipeline built for evidence",
    summary:
      "PayOps separates chain ingestion, canonical transfer facts, reconciliation decisions, delivery, and operator review so every decision can be reproduced.",
    readingTime: "11 min",
    sections: [
      {
        title: "The system boundary",
        body: [
          "PayOps begins with an invoice expectation and finalized public chain data. It ends with a persisted decision, replayable evidence, and a signed event for downstream systems. Creating wallets, quoting exchange rates, moving funds, and signing transactions stay outside this boundary.",
          "That narrow scope lets the system optimize for correctness, auditability, and safe failure instead of combining custody and accounting responsibilities in one service.",
        ],
      },
      {
        title: "One-way evidence flow",
        body: [
          "Finalized Solana transactions become canonical transfer records. Reconciliation compares those records with immutable invoice expectations. The result is persisted with its evidence before any webhook is queued.",
          "Every downstream view reads the persisted decision, including checkout status and accounting export. A webhook is a delivery mechanism for that truth, not a second place where payment truth is calculated.",
        ],
        code: "Solana RPC → ingestion → canonical transfer\ninvoice + transfer → decision + evidence\ndecision → signed event → your system",
      },
      {
        title: "Deterministic decisions",
        body: [
          "Parser versions are explicit and ordered. Replaying the same canonical transfer and invoice produces the same outcome, while conflicting representations fail closed.",
          "The recorded representation and rule version travel with the decision evidence, so a future parser or policy change cannot silently rewrite why an earlier invoice was considered paid.",
        ],
      },
      {
        title: "Atomic outbox and delivery",
        body: [
          "The lifecycle event and delivery rows are created in the same database transaction as the authoritative decision. A worker later claims due deliveries with a lease, signs the exact stored payload bytes, and records every attempt.",
          "Retries are bounded by attempt count and time horizon. Manual replay is an explicit one-shot operator action, and stale workers cannot complete a delivery reclaimed by another worker.",
        ],
      },
      {
        title: "Operational boundaries",
        body: [
          "Workers claim durable jobs with leases, delivery attempts are append-only, and stale workers cannot complete a reclaimed job. Review queues expose uncertainty instead of hiding it.",
          "Production controls separate merchant workflows from operational promotion, incident state, and readiness checks. This keeps routine invoice actions from bypassing deployment and safety gates.",
        ],
      },
      {
        title: "What to monitor",
        body: [
          "Monitor ingestion freshness, finalized slot lag, parser failures, unmatched or ambiguous transfers, reconciliation latency, webhook backlog, retry exhaustion, and exception age. Counts alone are not enough; track the oldest item in every durable queue.",
          "A healthy system can answer where a payment is in the pipeline and can reproduce the exact facts behind every terminal decision.",
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
    readingTime: "10 min",
    sections: [
      {
        title: "Why lifecycle events exist",
        body: [
          "Your product, finance system, CRM, and reporting jobs should not independently inspect Solana transactions and reach different conclusions. PayOps emits one versioned event after the authoritative decision is durably stored.",
          "Consumers receive business facts rather than raw chain interpretation. They can update an order, create an accounting entry, notify a customer, or open a review task without reimplementing reconciliation.",
        ],
      },
      {
        title: "Invoice paid",
        body: [
          "invoice.paid.v1 is emitted only after a finalized transfer exactly matches the expected mint, recipient, amount, and invoice reference.",
          "The envelope carries a stable event ID, occurrence time, source identity and version, invoice object, and the evidence fields needed to trace the decision. Treat the event as a statement about the persisted invoice state, not a request to recalculate it.",
        ],
        code: '{\n  "schemaVersion": "0.1",\n  "type": "invoice.paid.v1",\n  "object": { "type": "invoice", "id": "inv_0421" }\n}',
      },
      {
        title: "Payment exception",
        body: [
          "payment.exception.v1 carries the review reason and the evidence needed to investigate. An exception never silently mutates invoice state.",
          "The payload includes transfer signature and instruction coordinates, exact amount, review state, classification, code, and rule version. A consumer can route the exception without fetching or guessing the missing context.",
        ],
      },
      {
        title: "Verify the envelope",
        body: [
          "Verify the signature against the exact raw bytes first. Then validate the schema version, exact key sets, UUIDs, timestamps, event type and object pairing, and event-specific data before executing a side effect.",
          "During secret rotation, accept signatures from the current and previous secret for a short overlap. Never log either secret, the signature input, or an unbounded attacker-controlled error value.",
        ],
      },
      {
        title: "Replay safely",
        body: [
          "Deduplicate by event ID, persist before responding, and make downstream handlers idempotent. Manual replay preserves the same event and canonical payload bytes.",
          "If the side effect fails, leave the event unprocessed so the delivery can retry. If it succeeds, commit the processed event ID in the same local transaction as the side effect whenever your storage model allows it.",
        ],
      },
      {
        title: "Handle delivery outcomes",
        body: [
          "Return 2xx only after durable acceptance. Authentication or schema failures should return a terminal 4xx. Temporary network failures, rate limits, and server errors can be retried within the bounded policy.",
          "Operators can inspect attempt history without reading webhook secrets or dumping full payloads. A dead delivery remains available for investigation and an intentional one-shot manual replay.",
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
    readingTime: "12 min",
    sections: [
      {
        title: "No custody, no signing",
        body: [
          "PayOps needs public settlement addresses and read-only Solana RPC access. It does not request seed phrases, private keys, or transaction-signing authority.",
          "Compromise of the reconciliation service must not be enough to move merchant funds. Wallet policy and signing infrastructure should remain isolated from PayOps credentials and deployment roles.",
        ],
      },
      {
        title: "Trust finalized public facts",
        body: [
          "Eligibility begins with a finalized Solana transaction on the configured network. Supported token mints are explicit; symbols or user-supplied labels are never enough to establish asset identity.",
          "Canonical transfer fields are bounded and validated at ingestion and at the database boundary. Parser versions use a strict numeric contract so ordering remains total and reproducible.",
        ],
      },
      {
        title: "Fail-closed reconciliation",
        body: [
          "Only finalized Mainnet transfers from supported token mints are eligible. Mismatched amounts, recipients, references, or representations become explicit exceptions.",
          "The persistence layer recomputes and validates decisions against canonical invoice and transfer rows inside the transaction. Caller-supplied classifications or stale evidence cannot authoritatively mark another invoice paid.",
        ],
      },
      {
        title: "Safe webhook delivery",
        body: [
          "Endpoints are HTTPS-only. Delivery resolves and validates every DNS answer, pins the connection, preserves TLS hostname verification, blocks redirects, and signs the exact persisted body.",
          "Requests have bounded DNS, connection, response, body, and total time. Private, loopback, link-local, multicast, and otherwise unsafe addresses are rejected to reduce SSRF risk.",
        ],
        callout:
          "Rotate webhook secrets with an overlap window, then remove the previous secret after consumers have moved.",
      },
      {
        title: "Protect operators and credentials",
        body: [
          "Keep database, RPC, and webhook secrets in a managed secret store or environment-scoped CI secret. Inspection commands expose secret references and operational metadata, never secret values.",
          "Use least-privilege database roles, restrict production promotion, require review for releases, and retain an audit trail for exception resolution, replay, and export actions.",
        ],
      },
      {
        title: "Your integration responsibilities",
        body: [
          "PayOps cannot protect a consumer that parses before verification, performs a side effect before durable deduplication, or treats an exception as paid. Consumers must verify raw bytes, validate the envelope, and implement idempotent handlers.",
          "Before production, test key rotation, webhook replay, temporary endpoint failure, an invalid signature, an unsupported mint, an amount mismatch, and restoration from your database backup.",
        ],
      },
    ],
  },
  {
    slug: "packages",
    label: "Packages",
    title: "Use only the PayOps pieces you need",
    summary:
      "Seven focused npm packages cover contracts, offline verification, ingestion, durable reconciliation, webhooks, SDK access, and reference fixtures.",
    readingTime: "9 min",
    sections: [
      {
        title: "Pick the smallest useful surface",
        body: [
          "You do not need to install the whole monorepo into an application. Start from the boundary your team owns: API consumption, deterministic domain logic, ingestion, durable reconciliation, webhook delivery, or conformance fixtures.",
          "All packages share versioned contracts, but infrastructure packages intentionally expose lower-level responsibilities. Product applications normally need the SDK and contracts only.",
        ],
      },
      {
        title: "Product integration",
        body: [
          "@payops/sdk is the typed merchant API client. @payops/core parses and verifies canonical Solana payment fixtures offline. @payops/contracts defines the stable shared lifecycle event contracts.",
          "Use the SDK for merchant and checkout workflows. Use contracts when producing or consuming lifecycle events. Use core for deterministic transaction evidence and conformance checks, not invoice persistence.",
        ],
        code: "npm install @payops/sdk @payops/contracts",
      },
      {
        title: "Infrastructure integration",
        body: [
          "@payops/ingestion records Solana transfer representations. @payops/reconciliation persists decisions. @payops/webhooks delivers signed events with bounded retries.",
          "These packages assume you are operating workers and PostgreSQL. They provide migrations and explicit storage APIs so queues, leases, attempts, and evidence survive process restarts.",
        ],
      },
      {
        title: "Package responsibilities",
        body: [
          "Keep fixture parsing and offline verification in core, chain observation in ingestion, invoice allocation plus transaction and reporting concerns in reconciliation, and endpoint delivery in webhooks. Avoid importing storage internals into product code when the SDK or public contracts provide the required boundary.",
          "This separation makes upgrades reviewable: a parser change can be replayed, a reconciliation rule can be fixture-tested, and a delivery change cannot rewrite an earlier payment decision.",
        ],
      },
      {
        title: "Conformance",
        body: [
          "@payops/reference provides replayable fixtures and expected outcomes so integrations can prove they interpret the same payment facts the same way.",
          "Run conformance whenever you upgrade a package, parser, database migration, or event consumer. A release should preserve expected decisions unless the contract change is explicit and reviewed.",
        ],
      },
      {
        title: "Version and publish safely",
        body: [
          "Pin compatible package versions together, review release notes, and test the packed artifacts rather than relying only on source-tree imports. Verify native ESM loading and generated declarations in the same Node.js range used in production.",
          "Published PayOps packages are public and intended for normal npm installation. Production releases use provenance-aware automation and should not depend on a long-lived publishing token in application infrastructure.",
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
    readingTime: "14 min",
    sections: [
      {
        title: "API conventions",
        body: [
          "The merchant API is versioned under /v1 and uses JSON request and response bodies. Stable resource identifiers are separate from public checkout tokens and human-readable references.",
          "Validate status codes and typed response bodies rather than assuming every 2xx has the same shape. Keep the SDK at your server boundary so privileged merchant credentials are not exposed in browser code.",
        ],
      },
      {
        title: "Invoices and checkout",
        body: [
          "Create and issue invoices, generate public checkout links, inspect payment attempts, cancel unpaid invoices, and poll checkout status without exposing internal identifiers.",
          "Create the customer and settlement configuration first, then create an invoice with exact base-unit expectations. Issuing freezes the payment request and produces the public checkout surface used by the payer.",
        ],
        code: "POST /v1/invoices\nPOST /v1/invoices/{invoiceId}/issue\nGET  /pay/{checkoutToken}/status",
      },
      {
        title: "Customers and settlement wallets",
        body: [
          "Customer records group merchant references and invoices. Settlement-wallet records define the public Solana destination that an invoice may expect; they do not contain signing material.",
          "Deactivate or replace configuration through explicit state transitions. Historical invoice evidence continues to reference the settlement facts that were active when the invoice was issued.",
        ],
      },
      {
        title: "Exceptions and evidence",
        body: [
          "List reviewable payment exceptions, assign and resolve them through explicit state transitions, and download evidence packs or accounting exports.",
          "Resolution is an operator decision with an audit trail, not an edit to raw transfer facts. Evidence exports let finance trace invoice expectation, finalized transfer, rule version, decision, event, and delivery history.",
        ],
        code: "GET  /v1/exceptions\nPOST /v1/exceptions/{id}/resolve\nGET  /v1/evidence-packs/{invoiceId}",
      },
      {
        title: "Operations",
        body: [
          "Readiness, production controls, incident state, and promotion checks are exposed separately from merchant workflows.",
          "Use these endpoints for deployment gates and operator dashboards, not customer checkout. A production promotion should prove database migrations, supported network and mint configuration, webhook health, and required operational ownership.",
        ],
      },
      {
        title: "Errors, retries, and idempotency",
        body: [
          "Bounded validation errors should be corrected by the caller and not retried blindly. Temporary service failures may be retried with backoff when the operation is idempotent or carries a stable request identity.",
          "For webhook-driven state changes, deduplicate by event ID. For invoice creation and operational actions, preserve your own stable correlation identifier so a client timeout does not cause duplicate business records.",
        ],
      },
    ],
  },
] as const;

export function getDocPage(slug: string) {
  return docPages.find((page) => page.slug === slug);
}
