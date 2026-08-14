# @payops/ingestion

Durable, one-shot Solana payment ingestion for PayOps. It scans a merchant
token account through HTTP JSON-RPC, archives canonical transaction evidence,
stores instruction-level transfers and reference accounts in PostgreSQL, and
tracks confirmed transactions through finalization.

Choose this package when an operator needs durable RPC collection and
PostgreSQL evidence, rather than only offline transaction verification. It
requires Node.js 22.18 or newer and PostgreSQL 16. After the protected `v0.1.0`
release workflow publishes it:

```bash
npm install @payops/ingestion@0.1.0
```

The process never needs a private key. A production operator supplies a
PostgreSQL connection and a dedicated RPC endpoint with transaction-history
access.

## Local setup

From the repository root:

```bash
docker compose -f packages/ingestion/docker-compose.test.yml up -d --wait
export DATABASE_URL=postgres://payops:payops@127.0.0.1:55432/payops_test
export SOLANA_RPC_URL=https://your-dedicated-solana-rpc.example
pnpm build
node packages/ingestion/dist/cli.js migrate
```

Register the provider without storing its URL:

```bash
node packages/ingestion/dist/cli.js provider add \
  --id primary \
  --cluster mainnet-beta \
  --url-env SOLANA_RPC_URL
```

Register a settlement token account. Use `--from latest` for new monitoring,
or an explicit inclusive slot for a historical import:

```bash
node packages/ingestion/dist/cli.js watch add \
  --provider primary \
  --address <TOKEN_ACCOUNT> \
  --from latest

node packages/ingestion/dist/cli.js watch add \
  --provider primary \
  --address <TOKEN_ACCOUNT> \
  --from-slot <SLOT>
```

The command returns the watch ID. Run deterministic one-shot work with:

```bash
node packages/ingestion/dist/cli.js sync \
  --provider primary \
  --watch <WATCH_ID>

node packages/ingestion/dist/cli.js finality refresh \
  --provider primary \
  --limit 256

node packages/ingestion/dist/cli.js inspect watch --watch <WATCH_ID>
node packages/ingestion/dist/cli.js inspect signature --signature <SIGNATURE>
node packages/ingestion/dist/cli.js inspect signature \
  --signature <SIGNATURE> \
  --include-raw

node packages/ingestion/dist/cli.js rpc-smoke \
  --provider primary \
  --address <TOKEN_ACCOUNT>
```

Signature inspection returns discovery state, raw-snapshot metadata,
normalized transfers, references, retries, quarantines, and finality
observations. It omits raw transaction bodies unless the operator supplies
`--include-raw`. The RPC smoke command reads one address-history signature and
at most one confirmed transaction, then prints only redacted metadata and its
canonical digest.

Schedule `sync` and `finality refresh` at the cadence your product requires.
Each invocation acquires durable work leases, emits canonical JSON, and exits
without leaving a process supervisor behind.

## Exit codes

- `0`: work completed, or another sync worker already owns the target.
- `1`: retryable, incomplete, quarantined, or missing inspection result.
- `2`: invalid command or configuration.

RPC credentials are read only from the environment variable named in the
provider record. Reports contain the provider ID and hostname label, never the
full credential-bearing URL.
