# @payops/contracts

Stable, framework-neutral lifecycle contracts for PayOps integrations.

Choose this package when a producer or consumer needs the canonical PayOps
event vocabulary without database or delivery code. It requires Node.js 22.18
or newer. After the protected `v0.1.0` release workflow publishes it:

```bash
npm install @payops/contracts@0.1.0
```

The package exports strict TypeScript types, a fail-closed runtime parser, the
v0.1 event vocabulary, reconciliation exception codes, and Unicode
code-point length handling shared by producers and consumers.

```ts
import { parseLifecycleEventEnvelope } from "@payops/contracts";

const event = parseLifecycleEventEnvelope(JSON.parse(rawBody));
if (event === null) throw new Error("invalid lifecycle event");
```

Verify a webhook signature over its exact raw body before parsing JSON. The
contract validates shape and bounds; it does not authenticate a sender.

## JSON Schemas

The published `schemas/` directory contains deterministic Draft 2020-12
schemas for lifecycle events, payment fixtures, audit reports, and complete
webhook requests. `writeJsonSchemas(outputDirectory)` produces the same bytes
for tooling that needs to materialize them elsewhere. Run `pnpm schemas:check`
from the repository root to detect checked-in drift.

Each file is also exported at
`@payops/contracts/schemas/<schema-file>.v0.1.schema.json`.
