# @payops/pilot

Resumable, read-only historical audits of merchant Solana USDC and USDT payment
operations. It never signs transactions, holds keys, or moves funds. Requires
Node.js 22.18+, PostgreSQL 16, and a mainnet RPC endpoint.

```bash
npm install @payops/pilot@0.1.1
```

Obtain written merchant consent for the accounts, time range, invoice data,
operators, recipients, and retention period. Keep manifests, invoices, and
reports outside the source repository.

```bash
npx payops-pilot migrate
npx payops-pilot audit validate --manifest /secure/pilot/manifest.v0.1.json
npx payops-pilot audit run \
  --manifest /secure/pilot/manifest.v0.1.json \
  --private-output /secure/pilot/private \
  --redacted-output /secure/pilot/redacted
```

The command writes private merchant reports and redacted reports with stable
HMAC-derived pseudonyms. Files are atomic and mode `0600`; neither output
contains RPC URLs, secrets, raw transaction bodies, or wallet signatures.
Warnings such as incomplete coverage or pending finality must remain visible
and must not be interpreted as zero activity.

[Source, manifest examples, pilot safety guide, and license](https://github.com/payops-labs/solana-payment-ops)
