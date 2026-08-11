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

Open Core v0.1 has no hosted API, authentication, checkout UI, quote engine, or
merchant dashboard. Those concerns remain outside this release so the parser,
contracts, evidence, and delivery semantics can be reused independently.
