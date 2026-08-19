# @payops/ingestion

Durable, one-shot Solana payment ingestion. It archives canonical RPC evidence,
stores instruction-level token transfers in PostgreSQL, and tracks confirmed
transactions through finalization. Requires Node.js 22.18+, PostgreSQL 16, and
a history-capable Solana RPC endpoint.

```bash
npm install @payops/ingestion@0.1.1
export DATABASE_URL=postgres://user:password@localhost:5432/payops
export SOLANA_RPC_URL=https://your-solana-rpc.example
```

```bash
npx payops-ingestion migrate
npx payops-ingestion provider add \
  --id primary --cluster mainnet-beta --url-env SOLANA_RPC_URL
npx payops-ingestion watch add \
  --provider primary --address <TOKEN_ACCOUNT> --from latest
npx payops-ingestion sync --provider primary --watch <WATCH_ID>
npx payops-ingestion finality refresh --provider primary --limit 256
```

Run `sync` and `finality refresh` from cron or a supervisor. Each command
leases durable work, prints canonical JSON, and exits. No private key is
required. Credential-bearing RPC URLs are read from environment variables and
excluded from reports.

[Source, operator documentation, and license](https://github.com/payops-labs/solana-payment-ops)
