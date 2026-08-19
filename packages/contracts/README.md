# @payops/contracts

Framework-neutral lifecycle contracts shared by PayOps producers and consumers.
Requires Node.js 22.18 or newer.

```bash
npm install @payops/contracts@0.1.1
```

```ts
import { parseLifecycleEventEnvelope } from "@payops/contracts";

const event = parseLifecycleEventEnvelope(JSON.parse(rawBody));
if (event === null) throw new Error("invalid lifecycle event");
```

Exports strict TypeScript types, a fail-closed runtime parser, reconciliation
exception codes, Unicode-aware bounds, and deterministic Draft 2020-12 schemas.
Schema files are available under `@payops/contracts/schemas/*`.

Verify webhook signatures over the exact raw body before parsing JSON. These
contracts validate shape and bounds; they do not authenticate senders.

[Source, documentation, and license](https://github.com/payops-labs/solana-payment-ops)
