# Backup restore checklist

Use an explicitly named disposable PostgreSQL 16 target. A local Docker target
is sufficient before grant funding. Never restore over production, a shared
development database, or an unnamed database.

## Evidence record

- [ ] Source backup identifier:
- [ ] Source build revision:
- [ ] Restore operator:
- [ ] Restore start timestamp (UTC):
- [ ] Restore completion timestamp (UTC):
- [ ] Disposable target identifier:
- [ ] Target PostgreSQL version:
- [ ] Restored migration version:
- [ ] `SELECT 1` result:
- [ ] API readiness result:
- [ ] Worker readiness result:
- [ ] Evidence-pack read test result:
- [ ] Final outcome: `passed` or `failed`

## Procedure

1. Record the exact source and target identifiers above before changing state.
2. Confirm the target is disposable and contains no data that must be retained.
3. Restore with a PostgreSQL 16 client and fail on the first SQL error.
4. Connect with the least-privileged readiness roles and record the migration
   ledger, `SELECT 1`, API readiness, worker readiness, and one bounded
   evidence-pack read.
5. Save checksums and bounded command output without connection strings,
   customer records, wallet addresses, signatures, or secret values.
6. If any check fails, mark the drill failed and follow the incident checklist.
   Do not repair the restored state with manual SQL.
7. After evidence is saved, destroy only the exact disposable target recorded
   above. Confirm the identifier again before deletion.

## Zero-cost local drill

The repository's PostgreSQL 16 container and migration image may be used for
this drill. Keep the project name unique, bind no database port publicly, and
use generated throwaway credentials. Local evidence proves the recovery
procedure; it does not claim that a hosted production backup has been tested.
