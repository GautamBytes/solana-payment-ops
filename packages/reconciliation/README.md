# @payops/reconciliation

Deterministic invoice reconciliation for finalized Solana USDC and USDT
payments. It imports merchant invoice expectations, reads finalized transfer
evidence produced by `@payops/ingestion`, and records either one exact
allocation or an explicit exception.

## Safety model

- only finalized chain events are eligible;
- automatic allocation requires a unique imported reference plus exact mint,
  destination, amount, and payment deadline;
- missing, unknown, or ambiguous references never mark an invoice paid;
- imports and reconciliation runs are idempotent;
- token amounts use integer base units rather than floating-point values.

## CSV contract

The header must be exactly:

```csv
invoice_id,customer_id,expected_mint,destination_token_account,amount_base_units,reference_address,issued_at,due_at
```

See [`examples/invoices.csv`](examples/invoices.csv) for sanitized USDC and
USDT rows. Invoice IDs and references cannot be reused with different data.

## Local workflow

Start the repository PostgreSQL service and apply both schema groups:

```bash
docker compose -f packages/ingestion/docker-compose.test.yml up -d --wait
export DATABASE_URL=postgres://payops:payops@127.0.0.1:55432/payops_test
pnpm --filter @payops/ingestion build
node packages/ingestion/dist/cli.js migrate
pnpm --filter @payops/reconciliation build
node packages/reconciliation/dist/cli.js migrate
```

Import invoices, run matching, and print reports:

```bash
node packages/reconciliation/dist/cli.js invoice import \
  --file packages/reconciliation/examples/invoices.csv
node packages/reconciliation/dist/cli.js reconcile run
node packages/reconciliation/dist/cli.js report --format json
node packages/reconciliation/dist/cli.js report --format csv
```

Exit code `0` means success, `2` means invalid input or usage, and `1` means an
operational failure. Reports label non-exact transfers as exceptions or
unapplied cash; they never silently treat ambiguous funds as paid.
