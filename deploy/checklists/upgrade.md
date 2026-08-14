# Upgrade checklist

- [ ] Record current image digests and migration ledger; take and verify a backup.
- [ ] Build one revision and pass repository, container, role, readiness, and SIGTERM gates.
- [ ] Confirm previous application compatibility with the proposed forward-only migration set.
- [ ] Run role bootstrap idempotently, then the one-shot migrator; stop on any mismatch.
- [ ] Replace worker, API, and web with exact tested digests; verify durable readiness.
- [ ] Run low-value checkout, finality, webhook, evidence, and export checks.
- [ ] Roll back application images only when compatible; never roll back schema or ledger rows.
