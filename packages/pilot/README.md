# PayOps Pilot

`@payops/pilot` runs a resumable, read-only historical audit of a merchant's
Solana USDC and USDT payment operations. It configures existing PayOps
ingestion, finality, reconciliation, and report services in a fixed sequence;
it never signs transactions, holds keys, or moves funds.

Choose this package for a consented, historical merchant audit with private and
grant-safe output—not live payment processing. It requires Node.js 22.18 or
newer and PostgreSQL 16. After the protected `v0.1.0` release workflow
publishes it:

```bash
npm install @payops/pilot@0.1.0
```

This workflow is for a consenting merchant pilot. Obtain written approval for
the wallet or token-account identifiers, time range, invoice file, operators,
report recipients, and retention period before running it. Keep the manifest,
invoice CSV, consent record, and generated reports outside the Git repository.

## Requirements

- Node.js 22.18 or newer and pnpm 11.15.0;
- PostgreSQL 16 reachable through `DATABASE_URL`;
- one HTTPS mainnet RPC endpoint;
- canonical mainnet USDC or USDT invoice expectations; and
- pre-created private and redacted output directories owned by the operator.

The repository test database can be started with:

```bash
docker compose -f packages/ingestion/docker-compose.test.yml up -d --wait
export DATABASE_URL=postgres://payops:payops@127.0.0.1:55432/payops_test
```

Use a dedicated database and separate output directory for partner data. Do
not use the synthetic test database for a real merchant audit.

## Prepare the manifest

Copy `examples/manifest.v0.1.json` and `examples/invoices.csv` outside the
repository. The manifest supports only `mainnet-beta`; every watch is a Solana
token account with an explicit cutover slot and at least 32 overlap slots.
Token amounts in the CSV are positive base-unit decimal strings.

Set the invoice digest after the final CSV edit:

```bash
shasum -a 256 /secure/pilot/invoices.csv
```

Put the resulting lowercase digest in `invoices.expectedSha256`. The CSV path
is relative to the manifest directory and cannot escape it through `..`, an
absolute path, or a symlink.

The manifest names environment variables; it never contains their values:

```bash
export PAYOPS_MAINNET_RPC_URL=https://your-mainnet-provider.example
export PAYOPS_AUDIT_SECRET='use-a-random-secret-of-at-least-32-bytes'
mkdir -m 700 /secure/pilot/private /secure/pilot/redacted
```

Use a unique pseudonymization secret for the pilot. Losing it does not lose the
private report, but changing it changes every grant-safe pseudonym.

## Run

```bash
pnpm pilot migrate
pnpm pilot audit validate --manifest /secure/pilot/manifest.v0.1.json
pnpm pilot audit run \
  --manifest /secure/pilot/manifest.v0.1.json \
  --private-output /secure/pilot/private \
  --redacted-output /secure/pilot/redacted
```

`audit run` writes:

- `private-audit.json` and `private-audit.csv`, containing merchant review IDs;
- `grant-audit.json` and `grant-audit.html`, containing stable HMAC-derived
  pseudonyms instead of merchant, watch, invoice, customer, or event IDs.

Every artifact is written atomically with mode `0600`. Neither audience
contains RPC URLs, environment values, secrets, raw transaction bodies, or
wallet signatures. The private files still contain business identifiers and
must be treated as confidential. The redacted files contain aggregates and
pseudonymous operational evidence; merchant approval is still required before
sharing them.

The command emits one canonical JSON result. Exit code `0` means the audit is
complete, `1` means it is incomplete or hit a retryable operational failure,
and `2` means arguments, manifest data, configuration, or a path is invalid.

Inspect durable progress with:

```bash
pnpm pilot audit inspect --run b71f7d39-9bb4-4c37-a1ed-078601d8fd81
```

## Resume and interpretation

Run the same `audit run` command again after an RPC or database failure. The
manifest digest selects the existing run; completed stages and immutable
evidence are not repeated. Changing the manifest creates a new run.

Warnings have precise meanings:

- `coverage_incomplete`: at least one watch could not prove its whole range;
- `finality_pending`: detected or confirmed signatures still need finality;
- `open_retries`: ingestion has unresolved retry evidence;
- `open_quarantines`: evidence requires operator review; and
- `unclassified_finalized_value`: finalized events have no reconciliation
  decision yet.

Do not interpret zero matches as zero merchant activity when any warning is
present. Resolve the cause and resume until the result is complete, or present
the warning prominently with the report.

## Data handling and cleanup

- Never commit, upload, paste into issues, or attach private pilot artifacts to
  a pull request.
- Share only the merchant-approved redacted files and agreed aggregate metrics.
- Restrict database and filesystem access to named operators.
- Retain the consent record and report digests for the agreed period.
- At the end of that period, remove the manifest, invoice CSV, database, and
  reports using the merchant's approved secure-deletion process.
- A failed run preserves evidence for safe resumption; it does not authorize
  widening the wallet scope or substituting unrelated synthetic results.
