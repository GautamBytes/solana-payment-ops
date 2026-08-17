# Incident-response drill: 2026-08-17

## Result

Passed.

- Execution window: 2026-08-17T16:42:20Z to 2026-08-17T16:42:40Z
- Cleanup verification: 2026-08-17T16:42:48Z
- Smoke runner commit: `425cd62cc9e4fdc7ce2edbc4dfd392ae4778eb14`
- Application image revision: `3e44bc1439c4be4e72e7e6fb97b807a5ef74889a`
- Docker: 29.1.3, build f52814d
- PostgreSQL: 16.14
- Compose project: `payops-smoke-project-proof`

The application image revision differs only by the final smoke-runner restart
fix. No application, migration, package, or container source changed between
the image revision and the runner commit.

## Scenario

The exercise simulated a bounded worker outage after the API and web services
had reached healthy production-mode baselines. It did not disable an
authentication, authorization, rate-limit, database-role, TLS, or network
control.

## Assertions

1. API liveness and readiness returned HTTP 200 before the incident.
2. Web liveness and readiness returned HTTP 200 before the incident.
3. The runtime API and worker containers did not receive an administrator or
   migrator database URL.
4. The worker received SIGTERM through `docker compose stop --timeout 15` and
   exited with code 0.
5. The API returned HTTP 503 readiness twice consecutively while the worker was
   unavailable.
6. The worker restarted through a dependency-free Compose operation.
7. The API returned HTTP 200 readiness twice consecutively after recovery.
8. The recovered worker received a second graceful stop and exited with code 0.
9. The exact Compose project and restore target had no remaining containers
   after cleanup.

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

Failure output is capped and removes database credentials from connection
strings. The runner does not print generated secrets, private material,
customer data, wallet addresses, or unbounded service logs.

## Boundary

This local exercise proves that persisted worker readiness fails closed, the
documented recovery action restores readiness, and cleanup is exact. It does
not measure a hosted provider's alert-delivery latency, on-call response time,
or contractual recovery objective.
