# Solana Payment Operations

- Status: approved for implementation
- Date: 2026-08-06
- Repository: solana-payment-ops
- Working product name: Solana Payment Ops
- One-line promise: Take a Solana stablecoin payment from invoice to verified settlement and clean books.

## 1. Executive decision

Build a non-custodial payment-operations platform for businesses that invoice customers and receive stablecoins on Solana.

The first product is not another generic block explorer, transaction indexer, wallet, payment gateway, or token checkout. It is a dashboard-first, API-backed system that creates invoices, produces a Solana Pay checkout, detects and independently verifies payment, handles finality and payment exceptions, reconciles the transfer to the invoice, records an append-only ledger, delivers reliable webhooks, and creates a downloadable payment evidence pack.

The first customer is a crypto-native agency or SaaS company that already receives stablecoins and currently closes its books using wallet history, explorer tabs, screenshots, spreadsheets, and manual messages. These businesses are accessible as design partners, have recurring invoices, and feel the complete problem rather than only the checkout step.

Version one accepts canonical USDC and USDT on Solana. An invoice may be denominated in USD, EUR, GBP, or INR. The payer chooses an accepted stablecoin and receives a time-limited quote. Funds move directly from the payer to a merchant-owned wallet. The platform never controls private keys or customer funds.

The project has two layers:

1. PayOps Core, an open-source Solana payment lifecycle, parser, verifier, deterministic fixture suite, and reference integration that other Solana developers can build on.
2. PayOps Cloud, a hosted commercial dashboard, managed indexing, exception workflow, evidence storage, accounting exports, alerts, and future connectors.

The initial monorepo, including the usable hosted reference implementation, will be public under Apache-2.0. The commercial business sells managed hosting, reliability, storage, integrations, and support rather than access to correctness-critical source code.

This split gives the project both real users and a credible Solana public good. It aligns with the Solana Foundation's stated preference for open-source contributions, useful community offerings, Solana-specific work, and measurable milestones. A hosted commercial component is more naturally positioned for a convertible grant, while the open core can qualify for a standard public-goods grant. See [Solana Foundation grants and evaluation criteria](https://solana.org/grants-funding).

## 2. Why this problem is worth solving

Solana already settles stablecoin transfers quickly and cheaply. The missing layer is reliable business meaning.

A raw transaction indexer can answer that a token transfer occurred. A business still needs to know:

- Which invoice or customer the transfer belongs to.
- Whether it used the exact accepted mint rather than a lookalike token.
- Whether the amount, destination, reference, token program, cluster, and finality are correct.
- Whether a partial, duplicate, late, excessive, or unrelated transfer should change the invoice.
- Whether it is safe to fulfill the service or update downstream systems.
- How to post the receipt without double-counting it.
- How to retry webhook delivery without causing duplicate actions.
- What evidence an accountant, auditor, customer, or support agent can inspect later.

The official Solana Developer Platform provides transfer-level primitives but explicitly does not currently provide a checkout session, payment-intent object, invoice object, settlement webhooks, or Idempotency-Key support on payment endpoints. Its inbound records also do not expose Solana Pay references, so reference-based correlation requires direct transaction inspection over RPC. See [SDP payment concepts](https://docs.platform.solana.com/docs/payments/concepts) and [SDP accepting payments](https://platform.solana.com/docs/payments/accept-overview).

That gap is valuable because every serious merchant otherwise rebuilds a fragile version of the same state machine, parser, reconciliation rules, retry logic, and audit trail.

## 3. Why this must be Solana-specific

This is not a generic multi-chain accounting product with Solana added as a checkbox. Version one uses Solana-specific properties and failure modes:

- Solana Pay transfer requests provide interoperable wallet deep links and QR codes.
- A fresh 32-byte reference key can correlate a payment request before a transaction signature exists.
- References appear as read-only account keys and can be indexed with getSignaturesForAddress.
- Token transfers can appear in outer or inner instructions, including cross-program invocations.
- A single signature can contain multiple relevant transfer instructions, so signature alone is not a sufficient event identifier.
- Confirmed and finalized commitment levels require explicit product semantics.
- Versioned transactions and address lookup tables affect parsing.
- Associated token account derivation and exact token-program validation affect destination verification.
- Solana's low fees and fast inclusion make small global B2B invoice payments practical and enable a responsive payment-status experience.
- Future Solana-native expansion can add Kora fee sponsorship and Solana Pay transaction requests without changing the core business lifecycle.

The [Solana Pay specification](https://docs.solanapay.com/spec) standardizes transfer and transaction request URLs, reference keys carried as read-only account metadata, amounts, token mints, labels, messages, and memos. PayOps turns those protocol primitives into a reusable business-payment lifecycle.

## 4. Users and jobs to be done

### 4.1 Primary customer

Crypto-native agencies and SaaS companies that:

- Typically send at least 25 recurring customer invoices per month or already assign recurring staff time to stablecoin reconciliation.
- Already accept USDC, USDT, or both.
- Receive into one or a small number of business wallets.
- Have an owner, operator, or finance person manually reconciling transfers.
- Need customer-facing payment status and internal evidence.
- Prefer non-custodial software.

The economic buyer is initially the founder, operations lead, or finance lead. The daily user is the person issuing invoices and resolving exceptions.

### 4.2 Secondary users

- Customer payer: opens a hosted invoice, chooses USDC or USDT, scans or opens a Solana Pay request, and sees trustworthy progress.
- Developer integrator: creates invoices through an API and consumes signed lifecycle webhooks.
- Accountant or bookkeeper: reviews payment evidence, allocations, adjustments, and exports.
- Support operator: investigates a missing, late, partial, or incorrectly attributed payment without reading raw transactions.

### 4.3 Core jobs

- Create and issue a professional invoice in under two minutes.
- Let a customer pay from a compatible Solana wallet without merchant custody.
- Detect a submitted payment quickly and verify it independently.
- Avoid fulfilling on a failed, spoofed, wrong-mint, or rolled-back transfer.
- Convert every finalized transfer into either an invoice allocation or an explicit unapplied-cash item.
- Resolve abnormal cases through a controlled exception inbox.
- Produce a trustworthy record for accounting, support, and audit.
- Integrate the lifecycle into an existing SaaS product with a small API and dependable webhooks.

## 5. Positioning and competitive boundary

### 5.1 Category statement

Solana Payment Ops is the payment integrity and reconciliation layer between a Solana wallet and a business system.

It complements gateways, custody platforms, RPC providers, wallets, explorers, and accounting systems. It does not need to replace them to be useful.

The hosted invoice and checkout are the first delivery surface, not the main technical differentiation. Version one is merchant-wallet-native. The canonical lifecycle is designed to accept provider connectors, but the product must not claim operational provider neutrality until at least a second connector has shipped and passed the same conformance suite.

### 5.2 What existing categories solve

| Category or example | What it solves | Remaining opportunity for PayOps |
| --- | --- | --- |
| Solana transaction indexers, including the repository shown in the supplied screenshot | Streams and persists raw or normalized transactions | Does not provide invoice intent, exact business verification, allocations, exception ownership, ledger semantics, webhooks, or evidence |
| Solana Developer Platform | Custody wallets, transfers, balances, transfer states, policies, and ramps | No hosted checkout, invoice or payment-intent object, settlement webhook, or native inbound-reference surface today |
| MoonPay Commerce, formerly Helio | Checkout, pay links, widgets, subscriptions, plugins, and commerce tooling | PayOps differentiates through independent on-chain verification, open lifecycle semantics, exception handling, subledger integrity, and evidence |
| Copperx | Stablecoin invoices, payment gateway features, recurring billing, webhooks, and offramp integrations | PayOps should integrate as a neutral operational layer and win on independent verification, open fixtures, reconciliation depth, and portability |
| Request Finance | Crypto accounts payable, accounts receivable, payroll, invoices, and reporting | PayOps is narrower, Solana-native, embeddable, non-custodial, and focused on real-time payment integrity |
| Cryptio, Bitwave, and TRES | Enterprise digital-asset accounting, subledgers, controls, and ERP integration | PayOps starts before month-end accounting, at payment intent, customer checkout, finality, and exception resolution for smaller teams |
| Sphere, BVNK, Crossmint, and other payment infrastructure | Regulated payment orchestration, custody, stablecoin and fiat rails, or developer APIs | They are future connectors; the canonical lifecycle is designed to normalize their evidence after conformance-tested connectors exist |

### 5.3 Defensible wedge

The product is designed to accumulate an evidence graph:

invoice → quote → payment attempt → Solana reference → transaction instruction → verified transfer → finality → allocation → journal entry → webhook delivery → evidence artifact

At launch this graph is a useful data model, not a moat. Defensibility must be earned through adoption of the lifecycle schema and fixtures, accumulated exception cases, workflow depth, reliability, integrations, and customer history.

### 5.4 Explicit non-positioning

Do not market the product as:

- A cheaper Stripe clone.
- A block explorer with a dashboard.
- A generic crypto invoice generator.
- An exchange, offramp, remittance service, or custodian.
- A legal, tax, AML, KYC, FEMA, GST, or eBRC compliance product.
- A promise that receiving stablecoins satisfies export-realization requirements.

## 6. Product scope

### 6.1 Version-one capabilities

#### Merchant setup

- Create an organization and invite members.
- Configure role-based access for owner, operator, developer, accountant, and viewer.
- Connect a merchant-owned Solana settlement wallet.
- Prove wallet control with a domain-separated signed message containing organization ID, wallet address, cluster, nonce, issued-at time, and expiry.
- Enable canonical USDC, canonical USDT, or both.
- Configure invoice branding, functional currency, settlement policy, webhook endpoints, and accounting export preferences.

#### Customers and invoices

- Create and import customers.
- Create an invoice in USD, EUR, GBP, or INR.
- Add line items, tax labels supplied by the merchant, due date, customer reference, and notes.
- Save a draft, issue the invoice, copy the hosted payment link, cancel an unpaid invoice, or mark it overdue.
- Generate a stable public checkout token unrelated to internal database IDs.
- Keep legal and tax fields merchant-authored; the product does not calculate or certify legal compliance.

#### Hosted checkout

- Display merchant identity, invoice amount and currency, status, due date, and safe payment instructions.
- Let the payer choose any stablecoin the merchant enabled.
- Create a 15-minute quote for the selected stablecoin.
- Generate a Solana Pay transfer request, QR code, and mobile deep link.
- Show the exact mint, network, wallet destination, stablecoin amount, and quote expiry.
- Provide a signature-claim request if the payer used a wallet flow that omitted the reference. A public claim only proposes a match and never allocates money by itself. Allocation requires a source-owner signed claim challenge bound to the invoice and event, or explicit merchant approval, plus an atomic check that the event remains unallocated.
- Display detected, confirmed, finalized, paid, expired, and exception states without pretending confirmed is final.

#### Payment verification and reconciliation

- Observe relevant signatures in near real time.
- Backfill signatures durably after disconnections or process restarts.
- Fetch and archive the complete transaction response.
- Parse outer and inner SPL Token instructions.
- Validate cluster, transaction success, exact mint, exact token program, actual merchant destination, base-unit amount, reference presence, and commitment.
- Record confirmed as provisional and finalized as the default fulfillment boundary.
- Match exact payments automatically.
- Create exception cases for partial, over, duplicate, late, wrong-asset, missing-reference, cancelled-invoice, quote-expired, malformed, or RPC-disagreement cases.
- Allow an authorized operator to allocate, split, reject, or leave funds unapplied with an audit note.

#### Ledger and evidence

- Maintain an append-only double-entry operational subledger.
- Separate an immutable chain event from a mutable business allocation.
- Record payment, unapplied cash, adjustment, fee, and refund-preparation events separately.
- Reconcile subledger cash to on-chain token balances.
- Export payments, invoices, allocations, and journals as CSV.
- Provide a QuickBooks-compatible journal export in version one.
- Generate a Payment Evidence Pack as a downloadable JSON bundle and human-readable PDF.

#### Developer interface

- Provide a dashboard backed by the same application API used by external integrations.
- Support idempotent invoice creation and refund preparation.
- Publish OpenAPI documentation.
- Deliver signed, replayable lifecycle webhooks.
- Offer one TypeScript reference client after the core API is stable.

### 6.2 Payment Evidence Pack

Each pack contains:

- Merchant and invoice identifiers.
- The issued invoice snapshot.
- Invoice currency and total.
- Selected stablecoin and exact mint.
- Quote rate, source, timestamp, confidence, expiry, and rounding result.
- Merchant wallet ownership proof metadata.
- Solana signature, slot, transaction version, instruction location, cluster, token program, mint, destination, source, and exact base-unit amount.
- First-seen, confirmed, and finalized timestamps.
- Verification checks and their results.
- Allocation history.
- Partial, excess, late, duplicate, or manual-resolution decisions.
- Refund-preparation and merchant-signature references when applicable.
- Journal-entry references.
- Webhook event IDs and delivery summary.
- Human approvals and audit-log references.
- A canonical manifest digest, service Ed25519 signature, signing-key ID, and verification instructions.

The evidence pack is operational evidence, not a legal opinion or compliance certificate. A digest or service signature detects changes after generation but does not independently prove when an event occurred. Production retention therefore uses versioned object storage with object lock where available, restricted deletion, key rotation history, and an open verification command. An external trusted timestamp can be added for merchants that require independent time evidence.

### 6.3 Non-goals for version one

- Holding merchant or payer keys.
- Holding, pooling, sweeping, swapping, converting, or forwarding funds.
- Fiat collection, banking, exchange, onramp, or offramp.
- KYC, KYB, sanctions screening, tax calculation, or legal conclusions.
- Multi-chain support.
- Arbitrary token support.
- Token-2022 or confidential-transfer support.
- On-chain payment-intent programs or escrow.
- Recurring subscriptions.
- Outgoing contractor or payroll payouts.
- Automatic refunds.
- Automatic refunds to the original source token account.
- Full ERP or general-ledger replacement.
- Percentage-based fees on funds.

## 7. End-to-end user workflow

### 7.1 Merchant onboarding

1. The owner creates an organization.
2. The owner connects a mainnet merchant wallet.
3. The server issues a single-use nonce and human-readable ownership message.
4. The wallet signs the message without submitting a transaction.
5. The server verifies the signature, domain, address, organization, nonce, cluster, and expiry.
6. The owner enables USDC, USDT, or both.
7. The system derives and validates the merchant associated token accounts.
8. The owner configures invoice branding and a webhook endpoint or continues dashboard-only.
9. A test-mode invoice verifies the workflow before any mainnet invoice can be issued.

### 7.2 Invoice and quote

1. The merchant creates and issues an invoice.
2. The system freezes an immutable issued-invoice snapshot and opens a public checkout.
3. The customer selects USDC or USDT.
4. The quote service reads the invoice currency, fiat-to-USD rate when needed, stablecoin-to-USD rate, source timestamps, and confidence.
5. The service calculates the stablecoin amount using decimal or rational arithmetic, rounds once to the mint's supported precision, and stores every input.
6. The service creates a payment attempt with a cryptographically random 32-byte reference key and a 15-minute quote.
7. The checkout renders the Solana Pay transfer request.

### 7.3 Payment and verification

1. The customer's wallet composes and sends the transfer.
2. A subscription worker sees the reference or merchant destination and schedules transaction ingestion.
3. A durable backfill worker independently discovers the same signature if the subscription path misses it.
4. The parser produces one normalized event per relevant outer or inner transfer instruction.
5. The verifier checks every required property.
6. A valid confirmed event changes the checkout to paid pending finality but does not create the final cash posting.
7. A valid finalized event becomes eligible for allocation and ledger posting.
8. The reconciliation engine applies exact-match rules.
9. An exact payment is allocated and the invoice becomes paid.
10. A non-exact payment enters the exception inbox or unapplied-cash queue.
11. The outbox publishes stable webhook events after the database transaction commits.
12. The evidence artifact is generated or updated.

### 7.4 Exception resolution

An operator can:

- Allocate a partial payment and keep the invoice open.
- Apply excess to the same invoice only with an explicit adjustment.
- Split one transfer across invoices when business evidence supports it.
- Combine multiple transfers into one invoice.
- Review a missing-reference claim after full on-chain verification and require source-owner proof or explicit merchant approval before allocation.
- Mark a wrong-mint transfer unsupported without recognizing it as payment.
- Leave unrelated or ambiguous funds as unapplied cash.
- Prepare a refund transaction for the merchant to review and sign.
- Add a note, attachment, and reason code to every manual decision.

The operator cannot edit the underlying chain event, delete a journal entry, silently change an issued invoice, or auto-refund an exchange omnibus address.

## 8. On-chain payment design

### 8.1 Selected design: shared merchant wallet plus unique reference

For each accepted mint, payments settle into the associated token account owned by the merchant's connected wallet. Each payment attempt receives a fresh random 32-byte Solana Pay reference key.

For an SPL Token transfer request, the Solana Pay recipient field is always the verified merchant wallet owner address, never the associated token account. The request supplies the selected mint, and the payer wallet derives the destination associated token account from recipient plus mint. Verification and complete RPC ingestion use that derived token account as the credited destination and watched settlement address.

The reference is only account metadata inside the transfer instruction. It is not an on-chain account, signer, keypair, or PDA and requires no account creation, funding, rent, or private key.

Advantages:

- Funds go directly to the merchant.
- The platform is non-custodial.
- The merchant does not need a new funded or rent-bearing account per invoice.
- Balances do not fragment across deposit addresses.
- Solana Pay compatible wallets can use the standard transfer request.
- The reference can be known before the signature and queried independently.
- The same settlement wallet can support dashboard and API-created invoices.

Tradeoff:

Some wallet or manual-send flows can omit the reference. The system therefore needs a real unmatched-payment queue and signature-claim flow. A public transaction signature proves neither payer identity nor invoice ownership. A source-owner signed claim can prove control of the source owner at claim time but may still be insufficient for a custodian or exchange source; merchant approval remains the fallback. The reference is a correlation hint, never proof of payment.

### 8.2 Rejected alternative: unique destination per invoice

A unique destination makes the address itself a strong correlation key and matches the current SDP recommendation for its custody-wallet accept flow. It is rejected for the non-custodial version-one product because it creates merchant-controlled key or account provisioning, rent and account sprawl, fragmented balances, and sweeping or consolidation work.

It remains a future connector option for a custody provider that manages those addresses safely.

### 8.3 Rejected alternative: payment-intent PDA

An on-chain payment-intent account could provide stronger atomic identity and on-chain rules. It is rejected for version one because it introduces a custom program, upgrade and audit surface, compute and wallet-compatibility risk, and potential accidental custody semantics before the workflow has been validated.

A program is justified only when real customers require atomic commerce behavior that standard Solana Pay transfers cannot provide.

### 8.4 Transfer request now, transaction request later

Version one uses Solana Pay transfer requests for maximum wallet compatibility and minimum signing complexity.

Transaction requests become an expansion path for:

- Kora-sponsored fees.
- Additional signed metadata.
- Merchant-controlled refund preparation.
- Safe custom instructions.

The payment lifecycle and verification model remain independent of which request style constructed the transaction.

## 9. Asset and quote policy

### 9.1 Mainnet asset allowlist

Version one accepts only:

| Asset | Canonical Solana mainnet mint | Token program | Decimals |
| --- | --- | --- | --- |
| USDC | EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v | Legacy SPL Token Program | 6 |
| USDT | Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB | Legacy SPL Token Program | 6 |

The USDC address is published by [Circle](https://developers.circle.com/stablecoins/usdc-contract-addresses). The USDT address is published by [Tether](https://tether.to/en/supported-protocols/).

No code path trusts a display symbol. Validation uses the exact cluster, mint address, owner program, and token-account relationship.

Both assets must be owned by the legacy SPL Token Program at TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA. Any issuer migration or mint change requires a reviewed allowlist release; it is never accepted from runtime metadata alone.

### 9.2 Quote calculation

Supported invoice currencies are USD, EUR, GBP, and INR.

The stablecoin amount is calculated as:

invoice amount × fiat-to-USD rate ÷ stablecoin-to-USD rate

For a USD invoice, the fiat-to-USD rate is exactly one. All values are stored as decimal strings or integer ratios. Floating-point numbers are forbidden in quote and ledger code.

The calculation:

1. Normalizes the invoice amount to the currency's minor units.
2. Loads a rate snapshot from the configured primary adapter.
3. Loads a second source for sanity checking when available.
4. Rejects stale, missing, or low-confidence data.
5. Calculates at high internal precision.
6. Rounds up to six stablecoin decimals so the quoted token amount cannot underpay the invoice because of rounding.
7. Stores the exact formula inputs, output, and adapter identifiers.

### 9.3 Quote safety defaults

- Quote lifetime: 15 minutes.
- Stablecoin USD price maximum age: 30 seconds.
- Fiat FX maximum age: 5 minutes during an active market-data period.
- Maximum stablecoin confidence interval relative to price: 0.5%.
- Stablecoin circuit breaker: pause new quotes if the observed USD deviation exceeds 1%.
- Cross-source deviation limit: 0.5% when two sources are available.
- Transaction-time rule: the transfer slot must precede the quote's persisted expiry cutoff slot. The cutoff represents quote expiry plus a 90-second inclusion tolerance.
- A quote is single-use after a matching finalized payment fully consumes it.

Pyth is the preferred Solana-native source for stablecoin/USD depeg monitoring. A commercial FX adapter supplies EUR, GBP, and INR rates. Adapters are replaceable so the core does not depend on one vendor. See [Pyth price feeds](https://docs.pyth.network/price-feeds/core).

Each quote stores server issued-at and expiry times, the Solana slot observed at issuance, the RPC providers used, and a finalized expiry cutoff slot. A slot-time sampler defines that cutoff as the earliest finalized slot whose provider-consensus block time is at or after quote expiry plus the 90-second tolerance. Eligibility then compares slots, which makes reprocessing deterministic.

Solana block time is estimated and can be null. If the system cannot establish a trustworthy cutoff because block times are absent or materially disagree, the payment receives a quote_time_indeterminate exception and cannot auto-allocate. A live first-seen server timestamp is retained as evidence but is never proof that a transaction landed before expiry.

### 9.4 Abnormal quote outcomes

- A transfer below the quoted amount becomes partial.
- A transfer above the quoted amount becomes excess.
- A transfer that lands after the quote window becomes late and requires a policy decision.
- A transfer in a different enabled stablecoin does not silently consume the quote; it creates a wrong-asset exception and may be manually allocated after a new valuation snapshot.
- A detected depeg pauses new quotes for that asset. Existing transfers are still ingested and preserved, but require the policy in force when the quote was issued.

## 10. Verification rules

A reference match alone must never mark an invoice paid.

For each candidate transfer, the verifier requires:

1. The configured cluster is mainnet-beta for production.
2. The transaction exists and did not fail.
3. The transaction response is complete enough to parse.
4. The transfer instruction is a supported outer or inner SPL Token transfer.
5. The token program is the legacy SPL Token Program expected by the allowlist.
6. The mint is the exact canonical USDC or USDT mint selected for the attempt.
7. The actual credited token account is the expected merchant associated token account.
8. The destination token account is owned by the connected merchant wallet.
9. The event amount comes from a successful supported Token Program instruction in exact base units, and the sum of all parsed credits and debits affecting each token-account and mint pair reconciles to its pre-token and post-token balance delta.
10. The unique payment-attempt reference appears in the relevant instruction's account keys.
11. The signature and instruction location have not already been ingested.
12. The quote and invoice rules allow allocation.
13. Confirmed or finalized commitment is recorded explicitly.

If a wallet omits the reference, rules 1 through 9 and 11 still apply. Public amount, timing, destination, and signature data may propose a candidate match but never authorize automatic allocation by themselves. The event remains unmatched until a source-owner signed claim or an authorized merchant operator approves it. A payer-submitted signature alone is evidence for review, not allocation authority.

The parser must handle:

- Legacy and versioned transactions.
- Address lookup tables.
- Outer instructions.
- Inner instructions and cross-program invocations.
- Transfer and TransferChecked variants.
- Multiple relevant transfers in one transaction.
- Failed transactions.
- Missing block times.
- RPC responses that temporarily lack full transaction data.

The normalized chain-event identity is:

cluster + signature + outer instruction index + inner instruction index when present

Signature alone is not unique enough because one transaction can contain multiple business-relevant transfers.

A per-instruction transfer amount must not be compared directly with the transaction-wide account balance delta when several instructions affect the same token account. The parser first produces every relevant instruction event, then the verifier reconciles their aggregate effect to the account-level pre-token and post-token balances. A self-transfer whose source and destination resolve to the same token account produces no credited value and cannot satisfy a payment.

## 11. Ingestion, finality, and RPC reliability

### 11.1 Two-path ingestion

The low-latency path uses provider-supported log subscriptions that mention monitored merchant token accounts. A provider may additionally permit one-reference subscriptions for a small active set, but correctness and scale must not depend on one WebSocket subscription per invoice.

The complete durable path scans every monitored merchant settlement token account. Per-reference queries are supplemental discovery and correlation aids. Backfills use:

- getSignaturesForAddress.
- getTransaction.
- getSignatureStatuses.
- A persisted canonical slot-and-signature watermark per settlement token account and RPC provider.
- Newest-first pagination from a captured run head back to the prior committed watermark.
- No watermark advancement after a partial page, RPC error, missing transaction that still may become available, or failed persistence.
- Oldest-to-newest processing after all required pages are collected.
- Signature and instruction-coordinate deduplication across an overlapping slot window.
- Repeated status checks for every provisional event until it becomes finalized, failed, reverted, or quarantined.
- getSignatureStatuses with transaction-history search for older signatures, plus finalized getTransaction lookup when the recent status cache is insufficient.

The worker commits a new watermark only after every signature through the captured head is durably represented or placed into an explicit retry state. WebSockets improve responsiveness but are never the sole source of truth.

### 11.2 Provider strategy

- Configure a primary and a secondary production RPC provider.
- Use the primary for routine subscriptions and reads.
- Use the secondary for independent verification, provider-health comparison, and gap recovery.
- Quarantine events when providers disagree on transaction contents or finalized status.
- Preserve provider, request time, response hash, latency, and error metadata.
- Never use a public RPC endpoint for production payment guarantees. See [Solana production readiness](https://solana.com/docs/payments/production-readiness).

### 11.3 Finality semantics

- Detected means a candidate signature was observed.
- Confirmed means a supported RPC reports confirmed commitment and all verification checks pass. It is provisional.
- Finalized means the transaction is rooted at finalized commitment and the final verification pass succeeds.
- Allocated means a finalized transfer has been mapped to an invoice or unapplied-cash account.

The customer checkout may show confirmed quickly. The default webhook for irreversible fulfillment is payment.finalized or invoice.paid after finalized allocation.

If a confirmed event disappears, changes, or fails to finalize:

- Mark the provisional observation reverted or quarantined.
- Do not mutate an already posted final journal in place.
- If a final journal was posted because of a provider defect, create a compensating entry and a critical incident.
- Notify the merchant and downstream integrators with a stable correction event.

### 11.4 Raw and normalized storage

For every candidate event, store:

- Raw RPC transaction response.
- Response digest.
- Provider and endpoint class.
- Retrieval timestamps and commitment.
- Normalized transaction metadata.
- Normalized transfer events.
- Verification-result version.

Raw records are immutable. A parser upgrade creates a new normalized version and preserves the prior output for audit.

## 12. Reconciliation and ledger

### 12.1 Separation of facts and decisions

The chain event is an immutable external fact. The allocation is a business decision. The journal entry is the financial representation.

These are separate records so a later reallocation never rewrites the transaction.

### 12.2 Automatic allocation

An event auto-allocates only when:

- It is finalized.
- It passes every verifier rule.
- The reference maps to one active payment attempt.
- The selected mint matches.
- The base-unit amount exactly matches the unconsumed quoted amount.
- The invoice is open or partially paid.
- The event has no existing allocation.
- No conflicting event or RPC disagreement exists.

Anything else creates an exception or unapplied-cash record.

### 12.3 Double-entry model

Each organization selects one functional currency during onboarding. Every journal balances in integer minor units of that functional currency. Each stablecoin cash line also stores its native mint and integer token base-unit quantity, and each invoice line retains its source currency. Conversion uses immutable issue-time or settlement-time rate snapshots and exact rational arithmetic.

For an issued invoice when operational accounts-receivable posting is enabled:

- Debit accounts receivable in functional currency.
- Credit the merchant-selected revenue or invoice-clearing account in functional currency.

PayOps does not decide whether the credit is legally recognized revenue. The merchant or accountant chooses the mapping. Merchants that manage revenue recognition elsewhere can use invoice clearing and export only the cash-settlement journal.

For an exact finalized payment:

- Debit merchant on-chain cash for the settlement-time functional-currency value and store the received token base units.
- Credit accounts receivable for its functional-currency carrying value.
- Post any difference to the configured realized FX gain or loss account.

For an unmatched finalized receipt:

- Debit merchant on-chain cash at the receipt-time functional-currency valuation and store the token base units.
- Credit unapplied cash or payment clearing for the same functional-currency value.

When unmatched cash is later allocated:

- Debit unapplied cash.
- Credit accounts receivable.

All monetary amounts use integer minor units, token base units, or exact rational rates. Refunds, fees, discounts, write-offs, FX differences, and excess payments use separate journals. Corrections are compensating entries. Posted journals are never deleted or edited.

### 12.4 Ledger invariants

- Every journal balances.
- Every chain event has at most one active recognition path.
- Allocation totals cannot exceed event value without an explicit valuation adjustment.
- Invoice paid amount equals active finalized allocations plus approved adjustments.
- Wallet cash ledger can be reconciled to the observed token-account balance.
- Every journal balances in the organization's functional currency while token-quantity subledger totals reconcile independently by mint.
- Unrelated incoming activity lands in unapplied cash, while unrelated outgoing activity lands in unclassified-outflow suspense; neither can disappear.
- Wallet balance is not revenue.
- A confirmed-only event cannot create the final payment journal.
- Reprocessing any event is idempotent.

### 12.5 Wallet cutover and balance reconciliation

Connecting an existing wallet does not imply complete historical knowledge. Activation therefore records:

- A finalized cutover slot per settlement token account.
- The token base-unit opening balance at that slot from two agreeing RPC reads.
- An opening-balance valuation snapshot and journal in functional currency.
- Whether the merchant requested a bounded historical backfill before cutover.

From the cutover slot onward, the complete settlement-account scan ingests every balance-affecting instruction, including inbound transfer, outbound transfer, mint, burn, and account lifecycle events. Unknown incoming value posts to unapplied cash. Unknown outgoing value posts to unclassified-outflow suspense and raises an exception.

The system reports wallet-to-ledger reconciliation as complete only when every slot range from cutover through the comparison slot has a committed ingestion watermark and all balance-affecting events are represented. Any RPC gap, unresolved parser result, or provider disagreement changes reconciliation state to incomplete rather than claiming a zero difference.

## 13. State machines

### 13.1 Invoice

Primary progression:

draft → issued → open → payment_detected → paid_pending_finality → paid

Allowed branches:

- open → partial → payment_detected when another transfer arrives.
- issued or open → overdue after the due date.
- draft, issued, open, or overdue → cancelled only while finalized allocation total is zero.
- partial → closed_with_balance_adjustment only through an explicit credit note, write-off, or refund workflow.
- paid → partially_refunded or refunded after a merchant-signed refund settles.
- Any non-final state → exception when a blocking inconsistency exists.

Invoice status is derived from issued snapshot, due date, active allocations, and exception state. It is not an independently editable label.

### 13.2 Payment attempt

One public reference may appear in zero, one, or many transactions because of partial payments, duplicate sends, retries, or spam. A payment attempt is therefore a container whose presentation status is derived from all linked candidate events and finalized allocations; it is not a one-transaction state machine.

Attempt lifecycle:

created → quoted → awaiting_payment

Derived attempt states:

- detected when at least one candidate exists.
- confirmed when at least one qualifying candidate is verified at confirmed commitment.
- finalized when at least one qualifying candidate is verified at finalized commitment.
- partial when finalized allocations are greater than zero but below the amount due.
- fulfilled when finalized allocations satisfy the amount due.
- unmatched or quarantined when unresolved candidates require action.
- expired or superseded according to quote state, even if a later candidate arrives.
- failed only when attempt setup fails before an actionable payment request exists.

Each candidate chain event has its own lifecycle:

observed → fetched → parsed → verified_confirmed → verified_finalized → allocated

Candidate branches are rejected, unmatched, quarantined, or confirmation_revoked. A tiny, invalid, duplicate, wrong-mint, or spam transaction never consumes the attempt and never prevents a later valid payment.

A late transaction does not move an expired attempt backwards. It creates a linked late-payment event and exception.

### 13.3 Quote

- active → consumed
- active → expired
- active → invalidated by asset circuit breaker
- active → superseded before payment

### 13.4 Exception case

- open → assigned → investigating → resolved
- open or investigating → escalated
- resolved → reopened when new evidence appears

Every resolution requires a reason code, actor, time, and append-only audit event.

## 14. Idempotency and transaction-operation rules

### 14.1 Application API

Mutation endpoints that can create financially meaningful objects require Idempotency-Key.

The database enforces uniqueness for:

- Organization + idempotency key + operation type.
- Organization + external invoice ID.
- Merchant + payment-attempt reference.
- Cluster + signature + instruction coordinates.
- Merchant + operation type + external operation ID.
- Journal source type + source ID + journal purpose.
- Webhook endpoint + stable event ID + delivery attempt number.

The same key with the same normalized request returns the original result. The same key with a different request returns a conflict.

### 14.2 Future outbound operations

Refund and payout transaction preparation must:

- Persist the operation before building a transaction.
- Preserve all signature attempts under one operation ID.
- Rebroadcast identical signed bytes safely.
- Avoid rebuilding with a new blockhash while the prior signature outcome is unknown.
- Rebuild only after the prior attempt is terminally failed or expired.
- Never duplicate the application journal when a replacement signature succeeds.

Version one prepares refunds but the merchant wallet signs and submits them.

## 15. Webhooks

### 15.1 Delivery semantics

- Transactional outbox written in the same PostgreSQL transaction as the domain change.
- Stable event ID across every retry and manual replay.
- At-least-once delivery.
- No promise of global ordering.
- Object ID, object version, event creation time, and status-at-occurrence in every payload.
- Immutable payload bytes for a stable event ID across retries and manual replay. Consumers fetch the object when they need its latest state.
- Exponential backoff with jitter for up to 72 hours.
- Dead-letter state after the automatic retry window.
- Manual replay reuses the same event ID.
- Per-endpoint delivery history visible in the dashboard.

### 15.2 Signing

Each request includes:

- Event ID.
- Delivery ID.
- Timestamp.
- Signature version.
- HMAC signature over timestamp plus the exact raw request body.

Consumers receive documentation for:

- Constant-time signature comparison.
- A five-minute replay window.
- Secret rotation with overlapping current and previous secrets.
- Idempotent processing by event ID.

### 15.3 Safety

- Only HTTPS endpoints outside local, link-local, metadata, loopback, and private address ranges.
- DNS re-resolution checks to reduce rebinding risk.
- Restricted ports.
- Connection, response-size, and total-time limits.
- Redirects disabled or revalidated.
- Payloads contain no private key material and minimize customer PII.

### 15.4 Initial event set

- invoice.issued.
- payment.detected.
- payment.confirmed.
- payment.finalized.
- payment.confirmation_revoked.
- payment.exception_created.
- invoice.partial.
- invoice.paid.
- invoice.overpaid.
- refund.prepared.
- refund.finalized.
- evidence.ready.

Documentation labels confirmed events as provisional. invoice.paid is emitted only after finalized allocation.

## 16. Refund safety

Refunds are dangerous because the source token account can belong to an exchange, custodian, payroll platform, or omnibus wallet.

Version-one policy:

- Never automatically refund the transfer source.
- Require the merchant to enter or choose a verified return owner address. Address control alone does not prove refund entitlement; verification means a source-owner signed challenge bound to the invoice and refund request, or documented merchant approval after reviewing customer or custodian evidence.
- Prefer a wallet owner address and derive its associated token account for the exact refund mint. If an advanced flow supplies a token account, validate its exact mint, token program, owner, and account state before use.
- If the return associated token account does not exist, show the creation and rent cost and require explicit merchant approval before adding its creation instruction.
- Display source, destination, mint, amount, invoice, and reason in an approval screen.
- Require owner or finance-admin approval.
- Persist a refund intent that binds cluster, merchant source token account, return owner and destination token account, exact mint, exact base units, original allocation, operation ID, and expiry.
- Prepare an unsigned transaction from that frozen intent.
- Require the merchant wallet to sign and submit.
- Decode the actual signed transaction before submission and require exact equality with the frozen intent; any changed destination, mint, amount, program, source, or added unsupported instruction is rejected.
- Reuse the common transaction parser and finality ingestion, but apply a dedicated outbound-refund verifier whose source and destination invariants are the reverse of inbound collection.
- Link the refund journal to the original allocation.
- Support configurable dual approval for high-value refunds.

## 17. System architecture

### 17.1 Architectural style

Use a modular TypeScript monolith for version one. Financial state changes benefit from one database transaction boundary, one domain model, and simple operational deployment. Isolated packages keep extraction possible when real scaling pressure appears.

Deploy three runtime processes from one monorepo:

- Web: merchant dashboard and hosted checkout.
- API: authenticated and public HTTP endpoints.
- Worker: RPC ingestion, backfill, finality, reconciliation, outbox delivery, exports, and evidence generation.

### 17.2 Selected technology direction

- TypeScript on a current supported Node.js LTS.
- pnpm workspace and Turborepo.
- Next.js for dashboard and hosted checkout.
- Fastify for the explicit versioned API.
- PostgreSQL as the source of truth.
- Drizzle ORM plus explicit SQL migrations.
- PostgreSQL transactional outbox and job tables using row locks and skip-locked claiming.
- S3-compatible object storage for raw transaction archives and evidence artifacts.
- @solana/kit and official program clients for new Solana code because Solana currently recommends Kit over legacy web3.js.
- Wallet Standard for browser wallet connections.
- OpenTelemetry for traces, metrics, and structured logs.
- Vitest for unit and integration tests.
- Playwright for checkout and dashboard end-to-end tests.

No Redis or message broker is required initially. PostgreSQL provides atomicity between domain writes, jobs, and webhook outbox records. A broker can be introduced only when measured throughput or isolation requires it.

### 17.3 Module boundaries

- identity: users, sessions, organization membership, roles, MFA.
- merchants: settlement wallets, ownership proofs, asset settings.
- customers: business contacts and external IDs.
- invoices: line items, issued snapshots, status derivation.
- quotes: rate adapters, circuit breakers, decimal math.
- payment-attempts: references, Solana Pay requests, attempt states.
- solana-ingestion: subscriptions, cursors, backfills, raw archive.
- solana-parser: transaction and transfer normalization.
- verification: deterministic rules and versioned results.
- reconciliation: matching, allocation, exception creation.
- ledger: accounts, journals, lines, valuation snapshots.
- exceptions: assignment, evidence, resolution workflows.
- refunds: safe preparation and lifecycle tracking.
- webhooks: event schemas, outbox, signing, retries.
- evidence: bundle generation, hashing, PDF rendering.
- connectors: accounting export and future provider adapters.
- audit: append-only actor and system event history with signed evidence exports.

Modules communicate through typed domain commands and events, not direct cross-module table mutation.

### 17.4 Connector interfaces

The first connector is MerchantWalletConnector:

- Merchant owns the settlement wallet.
- PayOps reads chain activity.
- PayOps never signs transfers.

Future connectors can implement the same normalized lifecycle:

- Solana Developer Platform custody wallets.
- Sphere.
- Copperx.
- Crossmint.
- BVNK.
- Accounting products such as QuickBooks, Zoho Books, and Tally.

Provider-specific metadata remains attached without leaking provider states into the canonical core lifecycle.

## 18. Data model

Core tables and responsibilities:

| Entity | Purpose |
| --- | --- |
| organizations | Tenant and billing boundary |
| users, memberships, roles | Identity and access |
| merchant_wallets | Verified wallet, cluster, state, ownership proof, cutover slot, and opening balances |
| supported_assets | Exact mint, token program, decimals, issuer source, enablement |
| customers | Merchant-scoped payer records |
| invoices, invoice_items, invoice_snapshots | Draft and immutable issued invoice |
| quotes | Exact rates, sources, formula, output, expiry, safety checks |
| payment_attempts | Reference, selected asset, quote, expected amount, lifecycle |
| payment_candidates | One-to-many candidate events and independently derived states for an attempt |
| sync_cursors | Provider, watched address, committed watermark, captured head, and retry state |
| raw_transactions | Application-append-only archived RPC response and digest |
| chain_events | Signature and instruction coordinates |
| normalized_transfers | Parsed source, destination, mint, amount, program |
| verification_results | Versioned rule outcomes |
| allocations | Mapping from finalized value to invoice or unapplied cash |
| ledger_accounts | Merchant-scoped operational chart |
| journal_entries, journal_lines | Application-append-only balanced financial record |
| exception_cases, exception_actions | Operational resolution queue |
| refund_operations, refund_attempts | Prepared and merchant-signed refund lineage |
| webhook_endpoints | URL, secret versions, state |
| webhook_events, webhook_deliveries | Stable domain event and delivery history |
| evidence_artifacts | Bundle versions, object path, digest, signature, key ID, and retention state |
| connector_accounts | Provider and accounting integrations |
| audit_events | Application-append-only actor and system history |
| idempotency_records | Request fingerprint and stored response |

All tenant-owned rows carry organization ID and are protected by application checks plus PostgreSQL row-level security as defense in depth.

## 19. API surface

### 19.1 Merchant API

- POST /v1/invoices
- GET /v1/invoices
- GET /v1/invoices/{invoice_id}
- POST /v1/invoices/{invoice_id}/issue
- POST /v1/invoices/{invoice_id}/cancel
- POST /v1/invoices/{invoice_id}/payment-attempts
- GET /v1/payments
- GET /v1/payments/{payment_id}
- POST /v1/payments/claim
- GET /v1/exceptions
- POST /v1/exceptions/{case_id}/assign
- POST /v1/exceptions/{case_id}/resolve
- POST /v1/allocations
- POST /v1/refunds
- GET /v1/webhook-endpoints
- POST /v1/webhook-endpoints
- POST /v1/webhook-deliveries/{delivery_id}/replay
- POST /v1/evidence-packs
- GET /v1/exports/{export_id}

POST mutations that create financial or externally visible effects require Idempotency-Key.

### 19.2 Public checkout API

- GET /pay/{checkout_token}
- POST /pay/{checkout_token}/quotes
- GET /pay/{checkout_token}/status
- POST /pay/{checkout_token}/claim

Public endpoints use opaque high-entropy checkout tokens, strict rate limits, minimal data exposure, and no sequential identifiers.

A public claim creates a pending claim record only. If the source owner can sign, the challenge binds organization, invoice, chain-event identity, source owner, nonce, issued-at time, and expiry. Custodial or exchange senders that cannot sign require explicit merchant review. Allocation always uses a database transaction that locks the chain event and verifies it is still unallocated.

### 19.3 API behavior

- JSON request and response bodies.
- UTC RFC 3339 timestamps.
- Amounts as decimal strings and base-unit strings, never JSON floating-point numbers.
- Cursor pagination.
- Stable machine-readable error codes.
- Explicit object version.
- Request ID in every response.
- OpenAPI generated and checked in.

## 20. Security and privacy

### 20.1 Custody boundary

- No merchant private keys.
- No payer private keys.
- No server-side signer that can move merchant stablecoins.
- Read-only RPC access for payment ingestion.
- Merchant signs wallet ownership proof and any refund.

If Kora fee sponsorship is later introduced, its capped SOL-only authority is isolated from merchant stablecoin accounts and governed by allowlists, limits, and monitoring. See [Kora fee abstraction](https://solana.com/docs/payments/send-payments/payment-processing/fee-abstraction).

### 20.2 Account security

- Passkey or strong password authentication.
- Email verification.
- MFA required for owners and finance admins before mainnet activation.
- Short-lived sessions for high-risk operations.
- Reauthentication for wallet changes, webhook-secret views, refunds, and role changes.
- Wallet-change cooling-off period of 24 hours by default.
- Notifications to all owners on wallet, role, webhook, or refund-policy changes.
- Dual approval available for high-value manual allocations and refunds.

### 20.3 Application and infrastructure security

- Tenant-scoped authorization on every command and query.
- PostgreSQL row-level security defense in depth.
- Encryption in transit and at rest.
- Managed secret store; secrets never committed.
- Key and webhook-secret rotation.
- Rate limiting and abuse controls.
- Content Security Policy and safe checkout embedding policy.
- CSRF protection for cookie-authenticated mutations.
- Strict input validation.
- SSRF controls for webhook delivery.
- Append-only audit log.
- Dependency and container scanning.
- Least-privilege production identities.
- Separate production, test, and local clusters and databases.

Application permissions and database triggers prevent ordinary updates or deletes of posted journals, raw chain records, and audit events. A privileged database operator could still alter an ordinary database, so the product does not call those rows cryptographically immutable. Tamper evidence comes from signed manifests, retained signing-key history, database write-ahead-log and backup retention, object versioning or object lock, and the public evidence-verification command.

### 20.4 Data policy

- Minimize customer personal data.
- Never put PII in public Solana memos or references.
- Store wallet addresses as financial identifiers with restricted access.
- Define merchant-configurable retention for invoice documents.
- Retain financial and audit records according to merchant contract and applicable law.
- Allow removal or anonymization of non-financial contact data without corrupting financial evidence.

## 21. Failure-mode matrix

| Failure | Required behavior |
| --- | --- |
| WebSocket disconnect | Continue from persisted overlapping backfill; no permanent gap |
| Primary RPC lag | Retry with bounded backoff and compare secondary provider |
| RPC providers disagree | Quarantine; do not allocate or mark paid |
| Confirmed transaction rolls back | Revert provisional state, emit correction, never silently retain paid |
| Reference omitted | Ingest as unmatched; support verified signature claim |
| Reference forged or reused | Full destination, mint, amount, uniqueness, and finality checks prevent payment recognition |
| Wrong mint with same symbol | Reject through exact mint and program allowlist |
| Partial payment | Allocate finalized amount, mark invoice partial, keep balance due |
| Overpayment | Allocate expected amount only under explicit policy; excess remains separate |
| Duplicate transfer | Each event is preserved; second value becomes excess or unapplied, never duplicate journal |
| Multiple transfers in one signature | Identify by instruction coordinates and evaluate independently |
| Quote expires before inclusion | Compare event slot with the persisted expiry cutoff slot; indeterminate cutoff creates a fail-closed exception |
| Payment reaches cancelled invoice | Preserve as unapplied cash and create urgent exception |
| Customer pays different enabled asset | Wrong-asset exception and manual valuation decision |
| Stablecoin depegs | Pause new quotes for that asset; preserve incoming events; alert merchants |
| Worker crashes after database commit | Durable job or outbox is reclaimed and processed idempotently |
| Worker crashes before commit | No state change; source event is rediscovered |
| Webhook endpoint fails | Retry at least once semantics, then dead-letter and allow same-ID replay |
| Webhook consumer processes twice | Stable event ID enables consumer idempotency |
| Merchant changes wallet | Reverification, cooling-off, alert, and explicit invoice migration policy |
| Raw transaction parser changes | Version new normalized output; retain old result and raw response |
| Refund source is exchange omnibus | Never auto-refund source; require verified return address and merchant signature |
| On-chain wallet balance differs from ledger | Create reconciliation alert and classify unknown activity as unapplied cash |

## 22. Testing strategy

### 22.1 Unit tests

- Invoice, attempt, quote, exception, and refund state machines.
- Decimal and rational arithmetic.
- Currency and token rounding boundaries.
- Quote freshness, confidence, cross-source deviation, and depeg circuit breaker.
- Every verifier rule.
- Automatic allocation rules.
- Webhook signing and replay validation.
- Idempotency request fingerprinting.

### 22.2 Property and invariant tests

- Journal debits always equal credits.
- Reprocessing cannot duplicate chain events, allocations, journals, or webhook events.
- No finalized verified value disappears: it is allocated, unapplied, or in an explicit exception.
- Allocation never exceeds available event value without a compensating adjustment.
- Invoice derived state matches allocations for arbitrary event sequences.
- Quote math never under-collects because of rounding.

### 22.3 Solana fixture suite

The open fixture corpus includes deterministic examples for:

- Legacy transaction with Transfer.
- Legacy transaction with TransferChecked.
- Versioned transaction.
- Address lookup table.
- Outer transfer instruction.
- Inner transfer through CPI.
- Multiple transfers in one transaction.
- Multiple references.
- Missing reference.
- Reused reference.
- Failed transaction.
- Wrong mint.
- Wrong destination.
- Partial amount.
- Excess amount.
- Duplicate-looking but distinct transfer.
- Confirmed then unavailable simulation.
- Null block time.
- Unsupported Token-2022 instruction.

Each fixture includes raw RPC JSON, expected normalized events, expected verification outcome, and expected exception code.

### 22.4 Integration and end-to-end tests

- Local validator for real transaction construction and RPC behavior.
- LiteSVM for fast program and instruction fixtures where appropriate.
- Devnet smoke tests for wallet interoperability.
- Browser end-to-end checkout with Wallet Standard test wallets.
- PostgreSQL tests for locking, outbox, job reclaim, row-level security, and migration behavior.
- Evidence PDF rendering and digest verification.

### 22.5 Chaos and security tests

- Subscription gaps.
- RPC timeouts, stale reads, contradictory reads, and rate limits.
- Process termination before and after commit.
- Concurrent attempts to allocate the same event.
- Webhook DNS rebinding, private-network targets, slow responses, oversized bodies, and replay.
- Cross-tenant identifier guessing.
- Wallet ownership signature replay.
- Role escalation attempts.

### 22.6 Mainnet rollout safety

Run in read-only shadow mode for design partners before enabling customer-facing paid status. Compare PayOps output with merchant records, inspect every mismatch, and publish aggregate findings without exposing customer data.

## 23. Observability and service objectives

### 23.1 Core metrics

- Signatures observed by subscription.
- Signatures recovered only by backfill.
- RPC response latency and errors by provider.
- Time from block inclusion to detected, confirmed, finalized, and allocated.
- Parser and verifier result counts by version.
- Automatic match rate.
- Exception count and age by reason.
- Ledger-to-wallet reconciliation difference.
- Webhook delivery latency, retry count, and dead-letter rate.
- Quote failures by source and safety rule.
- Checkout conversion and abandonment.

### 23.2 Initial service objectives

- Healthy-provider payment detection p95 below 10 seconds.
- One hundred percent of finalized monitored transfers represented as allocated, unapplied, or explicit exception.
- At least 98 percent automatic matching for supported exact referenced payments.
- Zero false-positive automatic allocations in the pilot review set.
- Zero duplicate ledger postings.
- At least 99.9 percent successful webhook delivery within the retry window for valid endpoints.
- Critical RPC disagreement alerts within two minutes.
- Recovery from a 30-minute worker outage without lost events.

## 24. Product success metrics

### 24.1 Commercial pilot

The first useful pilot succeeds when:

- Three design partners connect real read-only merchant wallets and provide at least 30 days of comparison data.
- At least 200 eligible real mainnet payment events pass through the lifecycle.
- At least 85 percent of eligible reference-present or source-owner-verified events auto-match.
- One hundred percent of eligible supported-asset events are classified as allocated, unapplied, or a named exception.
- At least 98 percent of supported exact referenced payments auto-match.
- A manually reviewed sample shows zero false-positive automatic allocations and at least 90 percent correct exception classification.
- Median manual exception-resolution time and total reconciliation time fall by at least 70 percent against a one-week measured baseline.
- At least one partner integrates a webhook or API.
- At least one accountant uses an evidence pack or export during a close.
- No funds are custodied and no duplicate financial postings occur.
- At least one design partner signs a paid continuation or production-conversion agreement.

### 24.2 Public-good adoption

Track grant impact independently from commercial adoption:

- Two external projects install PayOps Core, use the fixture suite, or implement the lifecycle schema.
- One external maintainer reports a caught verification defect or contributes a fixture.
- Package releases, test coverage, reproducible conformance results, and documentation usage are public.
- No public-good milestone depends on invoice volume generated only by PayOps Cloud.

Leading activation metrics:

- Time from signup to verified wallet below 10 minutes.
- Time from verified wallet to first issued invoice below 10 minutes.
- First successful finalized payment within seven days.
- Weekly return by the finance or operations user.

## 25. Go-to-market

### 25.1 Design-partner offer

Offer a free 30-day Payment Integrity Audit:

1. Connect a read-only merchant wallet.
2. Import a sample of invoices or a CSV.
3. Reconstruct payment matches and exceptions.
4. Quantify manual work, unmatched receipts, duplicates, late payments, and missing evidence.
5. Run the next invoice batch in shadow mode.

The audit produces immediate value even before the customer changes its checkout.

### 25.2 Customer acquisition

- Recruit three to five agencies and SaaS companies through Superteam and the broader Solana developer community.
- Target founders, operations leads, finance leads, and fractional CFO or bookkeeping firms.
- Publish an anonymized quarterly Solana Payment Exceptions report.
- Release useful open fixtures and verification guides that attract developers.
- Partner with accounting firms, RPC providers, and payment platforms instead of treating every infrastructure company as a competitor.
- Build in India and sell globally; do not depend on a claim of regulatory arbitrage.

### 25.3 Pricing hypothesis

- Community: free Apache-2.0 self-hosting and local fixtures.
- Design-partner audit: one bounded free analysis with an executive sponsor and real historical data.
- Paid shadow pilot: USD 1,500 to USD 5,000 for onboarding, one wallet flow, measured baseline, and a written outcome report.
- Cloud Starter: pricing hypothesis of USD 99 per month after the pilot for low-volume invoicing, evidence, and standard retention.
- Cloud Operations: pricing hypothesis of USD 499 per month plus a transparent event-volume tier for multiple members, exception workflow, webhooks, advanced evidence, and priority support.
- Enterprise: negotiated for SSO, dedicated retention, provider connectors, security review, support, and service commitments.

Final recurring prices must be validated against analyst time saved and exception loss avoided. Never charge a percentage of funds received.

## 26. Grant strategy

### 26.1 Public-good story

Solana gives developers fast settlement primitives but not a standard, production-grade business lifecycle from payment intent to final reconciliation. PayOps Core will make that lifecycle reusable.

Open-source deliverables:

- Apache-2.0 monorepo and self-hosting instructions.
- Canonical payment-lifecycle schema.
- TypeScript transaction parser and verifier.
- Exact mint and destination validation helpers.
- Confirmed-versus-finalized state model.
- Deterministic exception taxonomy.
- At least 25 raw transaction fixtures and expected outcomes.
- Reference ingestion and overlapping-backfill worker.
- Signed webhook event schema and consumer examples.
- Reference dashboard or CLI for inspecting lifecycle events.
- Documentation for integrating PayOps Core into another Solana product.

These artifacts let other Solana teams avoid rebuilding and incorrectly implementing critical payment logic.

### 26.2 Commercial story

The hosted service pays for:

- Managed RPC failover and ongoing parser maintenance.
- Multi-tenant dashboard.
- Hosted checkout and invoices.
- Exception collaboration.
- Long-term evidence storage and PDFs.
- Accounting and provider connectors.
- Alerts, support, and service commitments.

### 26.3 Why the grant is credible

The Foundation states that standard grants focus on public goods and open-source work, while convertible grants can support public goods with a commercial component. It also evaluates why the work belongs on Solana and whether milestones and use of funds are clear.

A standard-grant application should fund only PayOps Core: lifecycle schema, fixtures, parser, verifier, reference and backfill worker, conformance tooling, and documentation. PayOps Cloud should be disclosed but funded by founder effort, customer pilots, Colosseum, or a convertible grant. This prevents the public-good application from disguising ordinary SaaS development as ecosystem infrastructure.

The Superteam India listing researched on 2026-08-06 shows:

- Up to USD 10,000 cheque size.
- USD 4,779 average grant.
- 125 recipients.
- Applications paused at the time of research.

See [Superteam India grant listing](https://superteam.fun/earn/grants/solana-foundation-india-grants/). Superteam India is not an immediate submission route while applications are paused. The team should build grant-ready proof now and apply when the program resumes, while immediately considering the Solana Foundation program, relevant RFPs, Colosseum, and ecosystem grants.

### 26.4 Pre-application proof gate

Complete these before requesting grant funding:

- Three written design-partner commitments.
- Thirty redacted real payment and reconciliation cases.
- One read-only historical import from a partner.
- A public repository with the lifecycle vocabulary, initial fixture format, and a working vertical trace from raw RPC response to verification report.

The application then demonstrates proof of work and customer evidence instead of asking the grant to fund discovery.

### 26.5 Eight-week public-good milestone proposal

#### Milestone 1: lifecycle and conformance format, weeks 1–2

- Published lifecycle schema version 0.1.
- Published exception taxonomy.
- Published fixture schema and ten representative fixtures.
- Command-line conformance runner that emits deterministic JSON.

Evidence: tagged release, specification documentation, and reproducible conformance output.

#### Milestone 2: open verifier, weeks 3–4

- Open-source parser and deterministic verifier.
- Twenty-five or more sanitized or generated raw transaction fixtures.
- Automated tests for outer, inner, versioned, partial, excess, missing-reference, wrong-mint, failed, and duplicate cases.
- Public technical documentation.

Evidence: tagged package release, CI results, coverage report, and independent fixture replay.

#### Milestone 3: durable reference ingestion, weeks 5–6

- Reference and merchant-address indexing.
- Persisted overlapping backfill cursors.
- Confirmed and finalized state transitions.
- Stable event identities across outer and inner instructions.
- Transactional outbox and signed reference webhook consumer.
- Example integration that maps an application payment intent to a verified Solana event.

Evidence: fault-injection demo, recovery test after a simulated ingestion outage, and public integration guide.

#### Milestone 4: real-data evaluation, weeks 7–8

- One 30-day read-only mainnet dataset from a committed design partner.
- At least 200 eligible payment events analyzed, or every event in the dataset when the full period contains fewer.
- Human-reviewed precision, false-positive, recovery, and performance results.
- Published anonymized results and integration postmortem.
- Signed production-conversion or paid-pilot decision from the design partner.

Evidence: partner confirmation, anonymized evaluation report, and tagged stable release.

### 26.6 Suggested initial public-good grant budget

For a USD 10,000 microgrant:

| Use | Amount |
| --- | ---: |
| Lifecycle schema, parser, verifier, and fixture engineering | USD 4,500 |
| Reference indexer, backfill recovery, conformance CLI, and example integration | USD 2,000 |
| RPC, test infrastructure, CI, and reproducible mainnet-data evaluation | USD 1,000 |
| Independent security and correctness review of the open core | USD 1,250 |
| Documentation, design-partner evaluation, and public results report | USD 750 |
| Contingency for provider and test costs | USD 500 |

Funds are milestone-linked and do not pay for hosted dashboard, checkout, pricing, or sales work. Founder labor on PayOps Cloud is contributed in kind or funded commercially.

## 27. Roadmap

### Phase 0: evidence before breadth

- Interview and onboard design partners.
- Collect redacted failure cases.
- Validate recurring pain and willingness to run a shadow pilot.
- Freeze lifecycle vocabulary and correctness invariants.

Kill or reposition the product if three credible design partners cannot show recurring manual reconciliation, abnormal-payment cases, or willingness to use the read-only pilot.

### Phase 1: open payment integrity core

- Transaction fixture format.
- Parser and verifier.
- Reference ingestion.
- Finality state machine.
- Reconciliation rule engine.
- Minimal CLI for fixture and transaction inspection.

### Phase 2: invoice-to-books pilot

- Authentication and organization setup.
- Merchant wallet ownership proof.
- Customers and invoices.
- Hosted checkout.
- USDC and USDT quotes.
- Exception inbox.
- Ledger.
- Webhooks.
- Evidence and CSV export.

### Phase 3: production hardening

- Secondary RPC verification.
- Mainnet shadow mode.
- Security hardening.
- Operational dashboards and alerts.
- QuickBooks-compatible export.
- Design-partner migration.

### Expansion sequence

1. Public API and TypeScript SDK.
2. Dedicated QuickBooks, Zoho Books, and Tally connectors.
3. Kora-powered gasless transaction requests.
4. Subscriptions and recurring invoices.
5. Contractor payout exception desk.
6. Provider and custody connectors.
7. Licensed offramp and bank-reconciliation connectors.
8. Marketplace and multi-merchant support.
9. India-specific exporter evidence workflow with qualified legal and accounting partners.

The incoming invoice lifecycle and outgoing payout lifecycle share ingestion, verification, exceptions, ledger, webhooks, and evidence. Starting with incoming invoices therefore builds the foundation for the larger payment-operations control plane without mixing two customer workflows into version one.

## 28. Legal and regulatory boundary

This design is a product and engineering plan, not legal, tax, accounting, or regulatory advice.

Version one is non-custodial. Its chain ingestion is read-only, but the overall product also creates payment requests and quotes and can prepare refund transactions for merchant signature; it must not be described as entirely read-only.

- No custody.
- No signing authority over merchant funds.
- No exchange or conversion.
- No fiat collection.
- No remittance or payment aggregation.
- No KYC or sanctions determination.
- No claim that a stablecoin receipt satisfies local export, tax, or banking rules.

Before any India-directed production mainnet collection pilot, obtain written Indian legal advice about FEMA, payment-aggregator, VDA-service, tax, data-protection, and export-document requirements. INR production quoting remains feature-gated until that review; development and deterministic tests can still support the currency model. Until then, target globally operating crypto-native businesses and describe evidence as operational, not statutory.

The expected data-protection posture, subject to counsel and contract, is that the merchant is the Data Fiduciary and PayOps is its Data Processor for payer, invoice, and wallet-mapping data. PayOps is a separate Data Fiduciary for its own account, billing, fraud-prevention, and security records. Contracts, retention, access, deletion, incident response, and subprocessor terms must reflect those roles before a production pilot.

## 29. Product principles

1. External facts are stored append-only; business decisions and corrections are appended.
2. Reference is correlation, not proof.
3. Confirmed is visible; finalized is actionable.
4. Every finalized value is allocated, unapplied, or explicitly exceptional.
5. Exact mint and base units beat symbols and floating-point displays.
6. WebSockets provide speed; backfills provide truth.
7. Merchant owns funds and signatures.
8. No silent automation for ambiguous money movement.
9. Dashboard and public API share one domain model.
10. Open correctness primitives; charge for managed operations.
11. Measure real payment outcomes, not vanity transaction counts.
12. Add an on-chain program only when customer evidence proves it is necessary.

## 30. Acceptance criteria for beginning implementation

The design is ready for implementation when the reviewer confirms:

- The primary user remains a crypto-native agency or SaaS company receiving invoices.
- Version one is incoming invoice collection and reconciliation.
- The platform remains merchant-owned and non-custodial.
- Both canonical USDC and USDT are supported.
- Dashboard-first and API-backed is correct.
- Multi-currency invoice quotes are correct.
- The shared merchant wallet plus unique-reference architecture is accepted.
- The open-core and hosted-cloud split is accepted.
- The non-goals are acceptable.
- The grant milestone structure is credible.

After approval, the next artifact is a detailed implementation plan with small vertical milestones, test-first acceptance checks, repository structure, dependency choices, database migrations, and deployment sequence. Implementation begins only from that reviewed plan.

## 31. Source index

Primary and official sources used for product and technical decisions:

- [Solana Foundation grants and funding](https://solana.org/grants-funding)
- [Superteam India Solana Foundation grant listing](https://superteam.fun/earn/grants/solana-foundation-india-grants/)
- [Solana Developer Platform payment concepts](https://docs.platform.solana.com/docs/payments/concepts)
- [Solana Developer Platform accept payments](https://platform.solana.com/docs/payments/accept-overview)
- [Solana Pay specification](https://docs.solanapay.com/spec)
- [Solana payment verification and finality](https://platform.solana.com/docs/payments/accept-verification)
- [Solana payment indexing and reconciliation](https://platform.solana.com/docs/payments/accept-indexing)
- [Solana production readiness](https://solana.com/docs/payments/production-readiness)
- [Solana getSignaturesForAddress RPC](https://solana.com/docs/rpc/http/getsignaturesforaddress)
- [Solana logsSubscribe RPC](https://solana.com/docs/rpc/websocket/logssubscribe)
- [Solana address verification](https://solana.com/docs/payments/send-payments/verify-address)
- [Kora fee abstraction](https://solana.com/docs/payments/send-payments/payment-processing/fee-abstraction)
- [Token-2022 extensions](https://www.solana-program.com/docs/token-2022/extensions)
- [Pyth price feeds](https://docs.pyth.network/price-feeds/core)
- [Circle USDC contract addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses)
- [Tether supported protocols](https://tether.to/en/supported-protocols/)

Competitive and workflow references:

- [MoonPay Commerce documentation](https://docs.hel.io/llms.txt)
- [Copperx invoice documentation](https://docs.copperx.io/integrate-payments/create-invoices)
- [Request Finance documentation](https://docs.request.finance/)
- [Sphere API](https://spherepay.co/products/api)
- [Cryptio reconciliation](https://www.cryptio.co/solutions/reconciliation)
- [Bitwave](https://www.bitwave.io/)
- [TRES](https://tres.finance/)
