# Upgrade checklist

- [ ] Record current image digests and migration ledger; take and verify a backup.
- [ ] Complete `backup-restore.md` against a separately named disposable PostgreSQL 16 target and retain bounded evidence.
- [ ] Build one revision and pass repository, container, role, readiness, and SIGTERM gates.
- [ ] Confirm previous application compatibility with the proposed forward-only migration set.
- [ ] Run role bootstrap idempotently, then the one-shot migrator; stop on any mismatch.
- [ ] Replace worker, API, and web with exact tested digests; verify durable readiness.
- [ ] Run low-value checkout, finality, webhook, evidence, and export checks.
- [ ] Roll back application images only when compatible; never roll back schema or ledger rows.
- [ ] Stop the upgrade when readiness is non-200 twice, a restore fails, an RPC disagreement opens, a worker heartbeat is stale, or webhook dead letters grow.
