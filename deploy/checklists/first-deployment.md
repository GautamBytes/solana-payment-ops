# First deployment checklist

- [ ] PostgreSQL 16 private networking, encryption, PITR, retention, and restore test are recorded.
- [ ] Six unique principals and secret-store ownership are recorded; no credential is shared.
- [ ] Role bootstrap succeeds; administrator access is removed from deployment and runtime.
- [ ] Hosted migration succeeds twice with one immutable ledger row per migration.
- [ ] API, worker, web, and migrator image digests refer to one source revision and numeric users.
- [ ] HTTPS origins, distinct RPC providers, production email, evidence signing, and USD-only policy validate.
- [ ] API/web liveness and readiness pass; worker jobs report recent successful identity-matching runs.
- [ ] First owner invitation is delivered and unused bootstrap access is removed.
- [ ] Low-value mainnet checkout reaches finalized reconciliation, webhook, evidence, and export.
- [ ] Monitoring, bounded logs, backup restore, rollback compatibility, and incident owner are verified.
