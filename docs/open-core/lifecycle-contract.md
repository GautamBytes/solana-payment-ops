# Lifecycle contract v0.1

`@payops/contracts` exports a strict, versioned envelope and event-specific data
schema for 13 events:

- `invoice.issued`, `invoice.cancelled`, `invoice.partial`, `invoice.paid`, and
  `invoice.overpaid`;
- `payment.detected`, `payment.confirmed`, `payment.finalized`,
  `payment.confirmation_revoked`, and `payment.exception_created`;
- `refund.prepared`, `refund.finalized`, and `evidence.ready`.

Every envelope has canonical schema version `0.1`, a UUID event ID, canonical
UTC timestamp, status at occurrence, typed object identity and positive version,
and exact event data. Unknown envelope, object, or data keys are rejected.
Public IDs are bounded by Unicode code points, token amounts are canonical
unsigned decimal strings within the SPL Token `u64` range, and required Solana
addresses and signatures are decoded rather than checked only by regex.

The package publishes Draft 2020-12 JSON Schemas for lifecycle events, webhook
requests, payment fixtures, and audit reports. `@payops/webhooks` re-exports the
lifecycle symbols for source compatibility.

Patch releases may tighten implementation defects without changing valid v0.1
payloads. Additive event or field changes require a new schema version; removing
or changing a valid field requires a new major package version.
