# Hosted alpha operator runbook

This is a provider-neutral deployment contract, not a hosted service. Do not accept live merchant traffic until every item in the first-deployment checklist has evidence attached.

## Initial deployment order

1. Provision PostgreSQL 16 on private networking with encrypted backups and point-in-time recovery.
2. Create six distinct login principals—administrator, migrator, runtime, production control, readiness verifier, and shadow projector—in the provider secret store.
3. Run `payops-platform bootstrap-production-roles` once with administrator access and the five restricted application principal names.
4. Remove administrator access from the deployment job and verify no runtime service contains it.
5. Run `payops-platform migrate-hosted` once with only `PAYOPS_MIGRATOR_DATABASE_URL`; a repeat must be idempotent.
6. Deploy API and worker from the same immutable image revision. API gets runtime/control/verifier URLs; worker gets runtime/projector URLs.
7. Deploy web with only exact public/server origins. No database or provider secret belongs in web.
8. Wait for API and web liveness, then durable API readiness. Keep public traffic off while readiness is 503.
9. Bootstrap the first owner with the one-shot platform command and immediately expire any unused invitation.
10. Perform one low-value internal mainnet checkout through finality, reconciliation, signed webhook, evidence pack, and accounting export.
11. Prove alert delivery and restore the latest backup into an isolated database before accepting live merchant traffic.

## Backup and restore

Enable daily full backups plus continuous WAL/PITR. Record database version, migration ledger names/checksums, and the matching four image digests. Quarterly and before upgrades, restore into an isolated PostgreSQL 16 instance, run role bootstrap idempotently, compare every ledger row/checksum, start the tested image revision, and exercise readiness. Never test a restore against production endpoints or secrets.

## Upgrade and rollback

Build all four targets from one commit, run `pnpm containers:test`, back up, apply the one-shot migrator, then replace worker, API, and web. Schema rollback is forward-only: never delete migration-ledger rows, edit applied SQL, or mutate checksums. An earlier application image may be restored only when its declared migration set includes every live ledger entry. Otherwise fix forward with a new migration.

## Secret rotation

- Auth secrets and checkout token keys: prepend the new key, retain the previous verification key for the bounded session/token lifetime, then remove it.
- Webhook sender secrets: register current plus previous secret, confirm receiver verification, rotate endpoint metadata, then retire the old secret after retries expire.
- Email, Pyth, commercial-FX, and RPC credentials: create a replacement at the provider, inject it, verify readiness/operations, then revoke the old credential. Preserve distinct RPC providers and endpoint variable names.
- Evidence signing: add a new key ID, deploy the private key, retain old public keys indefinitely for historical verification, and never replace a key under an existing ID.
- Database principals: rotate one principal at a time in the secret store, restart only its consumer, verify readiness and role assertions, then revoke the old password. Administrator and migrator remain absent from long-running services.

## Incident control

- RPC disagreement: keep promotion blocked, preserve both provider observations, and use production-control APIs; never overwrite chain evidence.
- Stale worker readiness: remove traffic, inspect job/lease state, and allow graceful lease release before replacement.
- Migration mismatch: stop rollout and compare immutable source checksums; never edit the ledger.
- Secret exposure: revoke first, preserve bounded logs, rebuild from a clean context, and rotate every downstream credential that could derive trust.
- Webhook exhaustion: inspect append-only attempts, correct the receiver, and use explicit one-shot replay.
- Suspected cross-tenant access: block promotion, preserve audit/evidence records, rotate sessions and affected credentials, and use incident/production-control APIs rather than manual SQL.

The environment inventory and database capability matrix are in [environment.md](environment.md). The local smoke uses generated credentials/certificates, deletes its exact project in `finally`, and never deploys externally:

```bash
pnpm containers:build
pnpm containers:test
```
