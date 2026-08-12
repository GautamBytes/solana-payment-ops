# Open-core architecture

PayOps v0.1 separates deterministic payment truth from application policy.

```text
raw Solana RPC
  -> @payops/core parse and verify
  -> @payops/ingestion immutable snapshots and finality
  -> @payops/reconciliation allocation or named exception
  -> @payops/contracts lifecycle envelope
  -> @payops/webhooks transactional delivery
```

PostgreSQL is the durable coordination boundary for ingestion,
reconciliation, and webhook delivery. Chain events use the cluster,
transaction signature, outer instruction index, and optional inner instruction
index as identity. Replaying the same observation cannot create a second event,
allocation, or delivery.

The libraries are framework-neutral. `examples/reference-integration` shows an
application-owned payment intent and PostgreSQL webhook receiver using public
package exports only. `@payops/pilot` composes the same libraries into a
read-only historical audit.

The hosted product composes those boundaries without changing their evidence
rules:

```text
merchant API -> capability checkout -> exact Pyth quote -> Solana Pay request
  -> ingestion/finality -> deterministic reconciliation -> paid or exception
  -> signed webhook + public status projection
```

Checkout tokens are bearer capabilities and are never stored raw. Quotes are
immutable and use integer/rational arithmetic with one final round-up to token
base units. Confirmed transfers remain provisional; only finalized, exact
matches can mark a merchant invoice paid.

Open Core v0.1 remains independent of the hosted API, authentication, checkout
UI, and quote engine, so its parser, contracts, evidence, and delivery semantics
can be reused by other Solana applications.
