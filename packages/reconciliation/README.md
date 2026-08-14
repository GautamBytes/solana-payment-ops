# @payops/reconciliation

Deterministic invoice reconciliation for finalized Solana USDC and USDT
payments. It records one exact allocation or an explicit exception. Requires
Node.js 22.18+, PostgreSQL 16, and evidence from `@payops/ingestion`.

```bash
npm install @payops/reconciliation@0.1.0
export DATABASE_URL=postgres://user:password@localhost:5432/payops
```

```bash
npx payops-reconciliation migrate
npx payops-reconciliation invoice import --file ./invoices.csv
npx payops-reconciliation reconcile run
npx payops-reconciliation report --format json
```

Automatic allocation requires finalized evidence, one unique imported
reference, and exact mint, destination, amount, and deadline matches. Missing,
unknown, ambiguous, or mismatched payments remain exceptions or unapplied cash;
they never silently mark an invoice paid. Amounts use integer base units.

A sanitized CSV example ships in `examples/invoices.csv`.

[Source, CSV contract, operator documentation, and license](https://github.com/GautamBytes/solana-payment-ops)
