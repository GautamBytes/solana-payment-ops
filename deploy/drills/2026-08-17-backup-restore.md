# Backup and restore drill: 2026-08-17

## Result

Passed.

- Execution window: 2026-08-17T16:42:20Z to 2026-08-17T16:42:40Z
- Cleanup verification: 2026-08-17T16:42:48Z
- Smoke runner commit: `425cd62cc9e4fdc7ce2edbc4dfd392ae4778eb14`
- Application image revision: `3e44bc1439c4be4e72e7e6fb97b807a5ef74889a`
- Docker: 29.1.3, build f52814d
- Source and target PostgreSQL: 16.14
- Compose project: `payops-smoke-project-proof`
- Disposable target: `payops-smoke-project-proof-restore`

The application image revision differs only by the final smoke-runner restart
fix. No application, migration, package, or container source changed between
the image revision and the runner commit.

## Procedure exercised

1. Generated throwaway database roles, passwords, signing material, ports, and
   TLS files in a private temporary directory.
2. Started the private PostgreSQL and synthetic upstream services without a
   public database port.
3. Bootstrapped six distinct database principals and applied the complete
   migration set twice.
4. Inserted one bounded synthetic recovery marker.
5. Streamed a custom-format `pg_dump` to a mode-0600 temporary file and
   computed its SHA-256 checksum.
6. Started a separately named PostgreSQL 16 restore target on the private
   Compose network with a read-only root filesystem and bounded in-memory data
   storage.
7. Streamed the dump into `pg_restore` with `--exit-on-error`, `--no-owner`, and
   `--no-privileges`.
8. Compared every ordered migration name and checksum between source and
   target, then verified the exact synthetic marker.
9. Removed the exact restore target and brought the exact Compose project down
   with volumes and orphans removed.

## Bounded evidence

The successful runner emitted:

```json
{
  "status": "ok",
  "images": 4,
  "roleSeparation": true,
  "backupRestore": true,
  "incidentRecovery": true,
  "gracefulShutdown": true
}
```

- Backup checksum: SHA-256 computed and validated as 64 lowercase hexadecimal
  characters. The bounded smoke output intentionally does not retain the raw
  digest after the disposable temporary directory is removed.
- Migration ledger: source and restore target matched exactly by ordered name
  and stored SHA-256 checksum.
- Synthetic marker: restored value matched exactly.
- Cleanup: no container remained for the Compose project or separately named
  restore target.

## Failed attempts retained in the record

Three earlier runs failed safely before this pass. They exposed an invalid
container copy path, missing disposable PostgreSQL data storage, and a startup
readiness race. A fourth reached incident recovery and exposed that `compose
start` re-evaluated a removed one-shot dependency. Each run removed its exact
resources. The runner now streams backup data through hardened containers,
uses bounded in-memory target storage, waits for stable PostgreSQL readiness,
and restarts only the worker without dependencies.

## Boundary

This is a local recovery-procedure exercise with synthetic data and disposable
containers. It proves the repository's restore path and assertions. It does not
claim that a hosted production backup, provider snapshot, or point-in-time
recovery system has been tested.
