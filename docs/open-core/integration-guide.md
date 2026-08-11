# Integration guide

Install the pieces your application needs:

```bash
npm install @payops/core@^0.1.0 @payops/contracts@^0.1.0 @payops/webhooks@^0.1.0
```

Resolve the bundled corpus in native ESM and run it:

```js
import { fileURLToPath } from "node:url";
import { evaluateManifest } from "@payops/core";

const manifest = fileURLToPath(
  import.meta.resolve("@payops/core/fixtures/v0.1/manifest.json"),
);
const report = await evaluateManifest(manifest);
if (!report.passed) throw new Error("PayOps conformance failed");
```

Before marking an invoice paid, bind your application-owned intent to the exact
mainnet cluster, canonical USDC or USDT mint, legacy SPL Token Program,
recipient owner, destination token account, integer base-unit amount, reference
account, and finalized commitment. Do not trust an expectation embedded in an
incoming fixture or RPC response.

For webhooks, preserve the raw HTTP body. Verify `timestamp + "." + rawBody`
with `verifyWebhook` before JSON parsing, then parse with
`parseLifecycleEventEnvelope`. Compare the request event ID with the body ID
and reserve that ID in the same database transaction as the application side
effect. See `examples/reference-integration` for concurrent retry behavior.

[Solana Pay transfer requests](https://solana.com/docs/tools/solana-pay/quickstart/transfer-requests)
can carry the recipient, SPL token, amount, and reference used by this flow.
PayOps verifies the resulting on-chain evidence; it does not replace the wallet
request protocol.
