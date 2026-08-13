import { runMigrations as runIngestionMigrations } from "@payops/ingestion";
import { runMigrations as runReconciliationMigrations } from "@payops/reconciliation";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  canonicalJson,
  completeIdempotency,
  digestIdempotentRequest,
  IdempotencyStore,
  OperationalHealthStore,
  OrganizationDatabase,
  type IdempotencyResponseCommitter,
} from "../src/index.js";
import {
  cleanupTestProductionRoles,
  runTestPlatformMigrations,
} from "./production-role-test-helper.js";

const baseDatabaseUrl = process.env.DATABASE_URL;
const describeDatabase = baseDatabaseUrl ? describe : describe.skip;
const schema = `payops_operational_health_${process.pid}`;
const databaseUrl = baseDatabaseUrl
  ? withSearchPath(baseDatabaseUrl, schema)
  : undefined;
const admin = baseDatabaseUrl
  ? postgres(baseDatabaseUrl, { max: 1, onnotice: () => undefined })
  : undefined;
const organizationId = "00000000-0000-4000-8000-000000000001";
const scopeKey = "a".repeat(64);
const healthRpc = rpcIdentity(
  "health-primary",
  "HEALTH_PRIMARY_RPC",
  "e",
  "health-secondary",
  "HEALTH_SECONDARY_RPC",
  "f",
);
const singleTestRpc = rpcIdentity(
  "single-test-primary",
  "SINGLE_TEST_PRIMARY",
  "1",
  "single-test-secondary",
  "SINGLE_TEST_SECONDARY",
  "2",
);
const recurrenceRpc = rpcIdentity(
  "recurrence-primary",
  "RECURRENCE_PRIMARY_RPC",
  "d",
  "recurrence-secondary",
  "RECURRENCE_SECONDARY_RPC",
  "e",
);

function rpcIdentity(
  primaryProviderId: string,
  primaryEndpointEnvironment: string,
  primaryDigestCharacter: string,
  secondaryProviderId: string,
  secondaryEndpointEnvironment: string,
  secondaryDigestCharacter: string,
) {
  return {
    mode: "dual_provider" as const,
    cluster: "mainnet-beta" as const,
    primaryProviderId,
    primaryEndpointEnvironment,
    primaryEndpointDigest: primaryDigestCharacter.repeat(64),
    secondaryProviderId,
    secondaryEndpointEnvironment,
    secondaryEndpointDigest: secondaryDigestCharacter.repeat(64),
  };
}

describeDatabase("operational health authority", () => {
  let database: OrganizationDatabase;
  let store: OperationalHealthStore;

  beforeAll(async () => {
    await admin!.unsafe(`CREATE SCHEMA ${schema}`);
  });

  beforeEach(async () => {
    await database?.close();
    await admin!.unsafe(`DROP SCHEMA ${schema} CASCADE`);
    await admin!.unsafe(`CREATE SCHEMA ${schema}`);
    await runIngestionMigrations(databaseUrl!);
    await runReconciliationMigrations(databaseUrl!);
    await runTestPlatformMigrations(databaseUrl!);
    database = new OrganizationDatabase(databaseUrl!, { max: 12 });
    store = new OperationalHealthStore(database);
  });

  afterAll(async () => {
    await database?.close();
    await admin!.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await cleanupTestProductionRoles(databaseUrl!);
    await admin?.end();
  });

  it("serializes one active episode and preserves exact occurrence history", async () => {
    const observations = Array.from({ length: 8 }, (_, index) =>
      store.observeIncident({
        organizationId,
        actorId: "worker",
        actorKind: "system" as const,
        kind: "rpc_disagreement" as const,
        severity: "critical" as const,
        scopeKey,
        observedAt: new Date(`2026-08-13T12:00:0${index}.000Z`),
      }),
    );
    const incidents = await Promise.all(observations);
    expect(new Set(incidents.map(({ id }) => id))).toHaveLength(1);
    expect(incidents.at(-1)).toMatchObject({
      kind: "rpc_disagreement",
      severity: "critical",
    });

    const page = await store.listIncidents({
      organizationId,
      actorId: "operator",
      limit: 10,
    });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      version: 8,
      occurrenceCount: 8,
      state: "open",
    });

    const history1 = await store.listIncidentHistory({
      organizationId,
      actorId: "operator",
      incidentId: page.items[0]!.id,
      limit: 3,
    });
    expect(
      history1.items.map(({ incidentVersion }) => incidentVersion),
    ).toEqual([8, 7, 6]);
    expect(history1.nextCursor).toEqual({
      incidentVersion: 6,
      id: history1.items[2]!.id,
    });
    const history2 = await store.listIncidentHistory({
      organizationId,
      actorId: "operator",
      incidentId: page.items[0]!.id,
      limit: 3,
      cursor: history1.nextCursor!,
    });
    expect(
      history2.items.map(({ incidentVersion }) => incidentVersion),
    ).toEqual([5, 4, 3]);
  });

  it("enforces optimistic transitions and opens a new episode on recurrence", async () => {
    const opened = await store.observeIncident({
      organizationId,
      actorId: "worker",
      actorKind: "system",
      kind: "ledger_mismatch",
      severity: "critical",
      scopeKey,
      observedAt: new Date("2026-08-13T12:00:00.000Z"),
    });
    const acknowledged = await store.acknowledgeIncident({
      organizationId,
      actorId: "operator",
      actorKind: "session",
      incidentId: opened.id,
      expectedVersion: opened.version,
      acknowledgedAt: new Date("2026-08-13T12:01:00.000Z"),
    });
    await expect(
      store.resolveIncident({
        organizationId,
        actorId: "operator",
        actorKind: "session",
        incidentId: opened.id,
        expectedVersion: opened.version,
        resolutionCode: "operator_resolved",
        resolvedAt: new Date("2026-08-13T12:02:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "incident_version_conflict" });
    const resolved = await store.resolveIncident({
      organizationId,
      actorId: "operator",
      actorKind: "session",
      incidentId: opened.id,
      expectedVersion: acknowledged.version,
      resolutionCode: "operator_resolved",
      resolvedAt: new Date("2026-08-13T12:02:00.000Z"),
    });
    expect(resolved).toMatchObject({ state: "resolved", version: 3 });

    const recurrence = await store.observeIncident({
      organizationId,
      actorId: "worker",
      actorKind: "system",
      kind: "ledger_mismatch",
      severity: "critical",
      scopeKey,
      observedAt: new Date("2026-08-13T12:03:00.000Z"),
    });
    expect(recurrence.id).not.toBe(opened.id);
    expect(recurrence).toMatchObject({ version: 1, occurrenceCount: 1 });
  });

  it("atomically records the acknowledged response for crash-window replay", async () => {
    const opened = await store.observeIncident({
      organizationId,
      actorId: "worker",
      actorKind: "system",
      kind: "worker_stale",
      severity: "warning",
      scopeKey,
      observedAt: new Date("2026-08-13T12:00:00.000Z"),
    });
    const actorId = "owner-session";
    const idempotency = new IdempotencyStore(database);
    const identity = {
      organizationId,
      actorKind: "session" as const,
      actorId,
      routeId: "operations.incidents.acknowledge",
      key: "acknowledge-crash-window-0001",
      requestDigest: digestIdempotentRequest({
        method: "POST",
        routeId: "operations.incidents.acknowledge",
        path: { incidentId: opened.id },
        body: { expectedVersion: opened.version },
      }),
    };
    const claimedAt = new Date("2026-08-13T12:01:00.000Z");
    const claim = await idempotency.claim(identity, claimedAt);
    if (claim.kind !== "execute") throw new Error("expected execution lease");

    const acknowledged = await store.acknowledgeIncident({
      organizationId,
      actorId,
      actorKind: "session",
      incidentId: opened.id,
      expectedVersion: opened.version,
      acknowledgedAt: claimedAt,
      idempotency: {
        committer: responseCommitter(claim, claimedAt),
        status: 200,
        responseBody: publicIncidentResponse,
      },
    });

    expect(acknowledged).toMatchObject({ state: "acknowledged", version: 2 });
    const replay = await idempotency.claim(
      identity,
      new Date("2026-08-13T12:01:01.000Z"),
    );
    expect(replay).toMatchObject({ kind: "replay", status: 200 });
    if (replay.kind !== "replay") throw new Error("expected replay");
    expect(Buffer.from(replay.body).toString("utf8")).toBe(
      canonicalJson(publicIncidentResponse(acknowledged)),
    );
    const history = await store.listIncidentHistory({
      organizationId,
      actorId,
      incidentId: opened.id,
      limit: 10,
    });
    expect(history.items.map(({ action }) => action)).toEqual([
      "acknowledged",
      "opened",
    ]);
  });

  it("atomically records the resolved response for crash-window replay", async () => {
    const opened = await store.observeIncident({
      organizationId,
      actorId: "worker",
      actorKind: "system",
      kind: "ledger_mismatch",
      severity: "critical",
      scopeKey,
      observedAt: new Date("2026-08-13T12:10:00.000Z"),
    });
    const actorId = "operator-session";
    const idempotency = new IdempotencyStore(database);
    const identity = {
      organizationId,
      actorKind: "session" as const,
      actorId,
      routeId: "operations.incidents.resolve",
      key: "resolve-crash-window-00000001",
      requestDigest: digestIdempotentRequest({
        method: "POST",
        routeId: "operations.incidents.resolve",
        path: { incidentId: opened.id },
        body: {
          expectedVersion: opened.version,
          resolutionCode: "operator_resolved",
        },
      }),
    };
    const resolvedAt = new Date("2026-08-13T12:11:00.000Z");
    const claim = await idempotency.claim(identity, resolvedAt);
    if (claim.kind !== "execute") throw new Error("expected execution lease");

    const resolved = await store.resolveIncident({
      organizationId,
      actorId,
      actorKind: "session",
      incidentId: opened.id,
      expectedVersion: opened.version,
      resolutionCode: "operator_resolved",
      resolvedAt,
      idempotency: {
        committer: responseCommitter(claim, resolvedAt),
        status: 200,
        responseBody: publicIncidentResponse,
      },
    });

    const replay = await idempotency.claim(
      identity,
      new Date(resolvedAt.getTime() + 1_000),
    );
    expect(replay).toMatchObject({ kind: "replay", status: 200 });
    if (replay.kind !== "replay") throw new Error("expected replay");
    expect(Buffer.from(replay.body).toString("utf8")).toBe(
      canonicalJson(publicIncidentResponse(resolved)),
    );
    const history = await store.listIncidentHistory({
      organizationId,
      actorId,
      incidentId: opened.id,
      limit: 10,
    });
    expect(history.items.map(({ action }) => action)).toEqual([
      "resolved",
      "opened",
    ]);
  });

  it("rolls back incident resolution when response completion fails", async () => {
    const opened = await store.observeIncident({
      organizationId,
      actorId: "worker",
      actorKind: "system",
      kind: "ingestion_gap",
      severity: "critical",
      scopeKey,
      observedAt: new Date("2026-08-13T13:00:00.000Z"),
    });
    const failingCommitter: IdempotencyResponseCommitter = {
      complete: async () => {
        throw new Error("simulated response commit failure");
      },
    };

    await expect(
      store.resolveIncident({
        organizationId,
        actorId: "operator-session",
        actorKind: "session",
        incidentId: opened.id,
        expectedVersion: opened.version,
        resolutionCode: "operator_resolved",
        resolvedAt: new Date("2026-08-13T13:01:00.000Z"),
        idempotency: {
          committer: failingCommitter,
          status: 200,
          responseBody: publicIncidentResponse,
        },
      }),
    ).rejects.toMatchObject({ code: "operational_health_unavailable" });
    await expect(
      store.listIncidents({ organizationId, actorId: "operator-session" }),
    ).resolves.toMatchObject({
      items: [expect.objectContaining({ state: "open", version: 1 })],
    });
  });

  it("atomically records deterministic incident absence and version conflicts", async () => {
    const actorId = "operator-session";
    const idempotency = new IdempotencyStore(database);
    const missingId = "00000000-0000-4000-8000-000000000099";
    const cases = [
      {
        incidentId: missingId,
        expectedVersion: 1,
        key: "acknowledge-missing-incident-0001",
        code: "incident_not_found",
        status: 404,
      },
      {
        incidentId: (
          await store.observeIncident({
            organizationId,
            actorId: "worker",
            actorKind: "system",
            kind: "webhook_dead_letter",
            severity: "warning",
            scopeKey,
            observedAt: new Date("2026-08-13T14:00:00.000Z"),
          })
        ).id,
        expectedVersion: 99,
        key: "acknowledge-version-conflict-01",
        code: "incident_version_conflict",
        status: 409,
      },
    ] as const;

    for (const testCase of cases) {
      const identity = {
        organizationId,
        actorKind: "session" as const,
        actorId,
        routeId: "operations.incidents.acknowledge",
        key: testCase.key,
        requestDigest: digestIdempotentRequest({
          method: "POST",
          routeId: "operations.incidents.acknowledge",
          path: { incidentId: testCase.incidentId },
          body: { expectedVersion: testCase.expectedVersion },
        }),
      };
      const now = new Date("2026-08-13T14:01:00.000Z");
      const claim = await idempotency.claim(identity, now);
      if (claim.kind !== "execute") throw new Error("expected execution lease");
      const response = {
        code: testCase.code,
        message: "Operation could not be completed",
      };

      await expect(
        store.acknowledgeIncident({
          organizationId,
          actorId,
          actorKind: "session",
          incidentId: testCase.incidentId,
          expectedVersion: testCase.expectedVersion,
          acknowledgedAt: now,
          idempotency: {
            committer: responseCommitter(claim, now),
            status: 200,
            responseBody: publicIncidentResponse,
            errorResponse: (code) => ({
              status: code === "incident_not_found" ? 404 : 409,
              body: response,
            }),
          },
        }),
      ).rejects.toMatchObject({
        code: testCase.code,
        idempotencyCompleted: true,
      });
      const replay = await idempotency.claim(
        identity,
        new Date(now.getTime() + 1_000),
      );
      expect(replay).toMatchObject({
        kind: "replay",
        status: testCase.status,
      });
      if (replay.kind !== "replay") throw new Error("expected replay");
      expect(Buffer.from(replay.body).toString("utf8")).toBe(
        canonicalJson(response),
      );
    }
  });

  it("returns the newest 100 history rows with a cursor for older rows", async () => {
    let incidentId = "";
    for (let version = 1; version <= 105; version += 1) {
      const incident = await store.observeIncident({
        organizationId,
        actorId: "worker",
        actorKind: "system",
        kind: "worker_stale",
        severity: "warning",
        scopeKey,
        observedAt: new Date("2026-08-13T12:00:00.000Z"),
      });
      incidentId = incident.id;
    }
    const newest = await store.listIncidentHistory({
      organizationId,
      actorId: "operator",
      incidentId,
      limit: 100,
    });
    expect(newest.items).toHaveLength(100);
    expect(newest.items[0]?.incidentVersion).toBe(105);
    expect(newest.items.at(-1)?.incidentVersion).toBe(6);
    expect(newest.nextCursor).not.toBeNull();

    const oldest = await store.listIncidentHistory({
      organizationId,
      actorId: "operator",
      incidentId,
      limit: 100,
      cursor: newest.nextCursor!,
    });
    expect(oldest.items.map(({ incidentVersion }) => incidentVersion)).toEqual([
      5, 4, 3, 2, 1,
    ]);
    expect(oldest.nextCursor).toBeNull();
  });

  it("aggregates bounded measurements and paginates incidents newest first", async () => {
    for (const value of [1, 2]) {
      await store.recordMeasurement({
        organizationId,
        actorId: "worker",
        kind: "rpc_consensus_checks",
        value,
        generatedAt: new Date("2026-08-13T12:01:00.000Z"),
      });
    }
    const snapshot = await store.getSnapshot({
      organizationId,
      actorId: "operator",
    });
    expect(snapshot.measurements).toContainEqual(
      expect.objectContaining({
        kind: "rpc_consensus_checks",
        value: 3,
        sampleCount: 2,
      }),
    );

    for (let index = 0; index < 5; index += 1) {
      await store.observeIncident({
        organizationId,
        actorId: "worker",
        actorKind: "system",
        kind: "webhook_dead_letter",
        severity: "warning",
        scopeKey: index.toString(16).padStart(64, "0"),
        observedAt: new Date(`2026-08-13T12:0${index}:00.000Z`),
      });
    }
    const first = await store.listIncidents({
      organizationId,
      actorId: "operator",
      limit: 2,
    });
    expect(first.items.map(({ lastObservedAt }) => lastObservedAt)).toEqual([
      "2026-08-13T12:04:00.000Z",
      "2026-08-13T12:03:00.000Z",
    ]);
    const second = await store.listIncidents({
      organizationId,
      actorId: "operator",
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect(second.items.map(({ lastObservedAt }) => lastObservedAt)).toEqual([
      "2026-08-13T12:02:00.000Z",
      "2026-08-13T12:01:00.000Z",
    ]);
  });

  it("treats absent authoritative worker facts as unhealthy", async () => {
    const observedAt = new Date();
    await expect(
      store.enqueueScheduledSignals({
        organizationId,
        actorId: "worker",
        observedAt,
        rpc: healthRpc,
      }),
    ).resolves.toBe(2);
    await store.drainSignals({
      organizationId,
      actorId: "worker",
      processedAt: new Date(observedAt.getTime() + 1),
    });
    await expect(
      store.listIncidents({ organizationId, actorId: "operator", limit: 10 }),
    ).resolves.toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ kind: "worker_stale", state: "open" }),
        expect.objectContaining({ kind: "ingestion_gap", state: "open" }),
      ]),
    });
  });

  it("does not resolve health incidents from a fresh single-provider worker", async () => {
    const observedAt = new Date();
    await store.enqueueScheduledSignals({
      organizationId,
      actorId: "worker",
      observedAt,
      rpc: singleTestRpc,
    });
    await store.drainSignals({
      organizationId,
      actorId: "worker",
      processedAt: new Date(observedAt.getTime() + 1),
    });

    const recoveredAt = new Date(observedAt.getTime() + 310_000);
    const workerId = "00000000-0000-4000-8000-000000000096";
    await database.transaction(
      { organizationId, actorId: "test" },
      async (sql) => {
        await sql`
          INSERT INTO rpc_providers (
            id, cluster, endpoint_env, endpoint_label, active, created_at
          ) VALUES
            ('single-test-primary', 'mainnet-beta', 'SINGLE_TEST_PRIMARY',
              'single test primary', true, now()),
            ('single-test-secondary', 'mainnet-beta', 'SINGLE_TEST_SECONDARY',
              'single test secondary', true, now())
        `;
        await sql`
          INSERT INTO rpc_provider_roles (
            organization_id, cluster, role, provider_id, created_at
          ) VALUES
            (${organizationId}::uuid, 'mainnet-beta', 'primary',
              'single-test-primary', now()),
            (${organizationId}::uuid, 'mainnet-beta', 'secondary',
              'single-test-secondary', now())
        `;
        await sql`
          INSERT INTO worker_instances (
            id, state, build_revision, rpc_mode, rpc_cluster,
            primary_provider_id, primary_endpoint_env, primary_endpoint_digest,
            started_at, last_heartbeat_at
          ) VALUES (
            ${workerId}::uuid, 'running', 'single-test', 'single_provider',
            'mainnet-beta', 'single-test-primary', 'SINGLE_TEST_PRIMARY',
            ${"1".repeat(64)},
            ${observedAt.toISOString()}, ${recoveredAt.toISOString()}
          )
        `;
        await sql`
          UPDATE worker_job_states SET interval_ms = 2_000,
            last_attempted_at = ${recoveredAt.toISOString()},
            last_succeeded_at = ${recoveredAt.toISOString()},
            last_attempt_instance_id = ${workerId}::uuid,
            last_success_instance_id = ${workerId}::uuid
          WHERE name = 'ingest_watch_targets'
        `;
      },
    );

    await store.enqueueScheduledSignals({
      organizationId,
      actorId: "worker",
      observedAt: recoveredAt,
      rpc: singleTestRpc,
    });
    await store.drainSignals({
      organizationId,
      actorId: "worker",
      processedAt: new Date(recoveredAt.getTime() + 1),
    });
    const incidents = await store.listIncidents({
      organizationId,
      actorId: "operator",
      limit: 10,
    });
    expect(
      incidents.items
        .filter(({ kind }) => ["worker_stale", "ingestion_gap"].includes(kind))
        .map(({ kind, state }) => ({ kind, state }))
        .sort((left, right) => left.kind.localeCompare(right.kind)),
    ).toEqual([
      { kind: "ingestion_gap", state: "open" },
      { kind: "worker_stale", state: "open" },
    ]);
  });

  it("does not resolve health incidents from wrong endpoint digests", async () => {
    const observedAt = new Date();
    const rpc = {
      mode: "dual_provider" as const,
      cluster: "mainnet-beta" as const,
      primaryProviderId: "identity-test-primary",
      primaryEndpointEnvironment: "IDENTITY_TEST_PRIMARY",
      primaryEndpointDigest: "4".repeat(64),
      secondaryProviderId: "identity-test-secondary",
      secondaryEndpointEnvironment: "IDENTITY_TEST_SECONDARY",
      secondaryEndpointDigest: "5".repeat(64),
    };
    await store.enqueueScheduledSignals({
      organizationId,
      actorId: "worker",
      observedAt,
      rpc,
    });
    await store.drainSignals({
      organizationId,
      actorId: "worker",
      processedAt: new Date(observedAt.getTime() + 1),
    });

    const recoveredAt = new Date(observedAt.getTime() + 310_000);
    const workerId = "00000000-0000-4000-8000-000000000095";
    await database.transaction(
      { organizationId, actorId: "test" },
      async (sql) => {
        await sql`
          INSERT INTO rpc_providers (
            id, cluster, endpoint_env, endpoint_label, active, created_at
          ) VALUES
            ('identity-test-primary', 'mainnet-beta', 'IDENTITY_TEST_PRIMARY',
              'identity test primary', true, now()),
            ('identity-test-secondary', 'mainnet-beta', 'IDENTITY_TEST_SECONDARY',
              'identity test secondary', true, now())
        `;
        await sql`
          INSERT INTO rpc_provider_roles (
            organization_id, cluster, role, provider_id, created_at
          ) VALUES
            (${organizationId}::uuid, 'mainnet-beta', 'primary',
              'identity-test-primary', now()),
            (${organizationId}::uuid, 'mainnet-beta', 'secondary',
              'identity-test-secondary', now())
        `;
        await sql`
          INSERT INTO worker_instances (
            id, state, build_revision, rpc_mode, rpc_cluster,
            primary_provider_id, primary_endpoint_env, primary_endpoint_digest,
            secondary_provider_id, secondary_endpoint_env,
            secondary_endpoint_digest, started_at, last_heartbeat_at
          ) VALUES (
            ${workerId}::uuid, 'running', 'identity-test', 'dual_provider',
            'mainnet-beta', 'identity-test-primary', 'IDENTITY_TEST_PRIMARY',
            ${"2".repeat(64)}, 'identity-test-secondary',
            'IDENTITY_TEST_SECONDARY', ${"3".repeat(64)},
            ${observedAt.toISOString()}, ${recoveredAt.toISOString()}
          )
        `;
        await sql`
          UPDATE worker_job_states SET interval_ms = 2_000,
            last_attempted_at = ${recoveredAt.toISOString()},
            last_succeeded_at = ${recoveredAt.toISOString()},
            last_attempt_instance_id = ${workerId}::uuid,
            last_success_instance_id = ${workerId}::uuid
          WHERE name = 'ingest_watch_targets'
        `;
      },
    );

    await store.enqueueScheduledSignals({
      organizationId,
      actorId: "worker",
      observedAt: recoveredAt,
      rpc,
    });
    await store.drainSignals({
      organizationId,
      actorId: "worker",
      processedAt: new Date(recoveredAt.getTime() + 1),
    });
    const incidents = await store.listIncidents({
      organizationId,
      actorId: "operator",
      limit: 10,
    });
    expect(
      incidents.items
        .filter(({ kind }) => ["worker_stale", "ingestion_gap"].includes(kind))
        .map(({ kind, state }) => ({ kind, state }))
        .sort((left, right) => left.kind.localeCompare(right.kind)),
    ).toEqual([
      { kind: "ingestion_gap", state: "open" },
      { kind: "worker_stale", state: "open" },
    ]);
  });

  it("derives stale and ingestion-gap episodes from persisted worker facts", async () => {
    const observedAt = new Date();
    await database.transaction(
      { organizationId, actorId: "test" },
      async (sql) => {
        await sql`
          INSERT INTO rpc_providers (
            id, cluster, endpoint_env, endpoint_label, active, created_at
          ) VALUES
            ('health-primary', 'mainnet-beta', 'HEALTH_PRIMARY_RPC',
              'health primary', true, now()),
            ('health-secondary', 'mainnet-beta', 'HEALTH_SECONDARY_RPC',
              'health secondary', true, now())
        `;
        await sql`
          INSERT INTO rpc_provider_roles (
            organization_id, cluster, role, provider_id, created_at
          ) VALUES
            (${organizationId}::uuid, 'mainnet-beta', 'primary',
              'health-primary', now()),
            (${organizationId}::uuid, 'mainnet-beta', 'secondary',
              'health-secondary', now())
        `;
        await sql`
          INSERT INTO worker_instances (
            id, state, build_revision, rpc_mode, rpc_cluster,
            primary_provider_id, primary_endpoint_env, primary_endpoint_digest,
            secondary_provider_id, secondary_endpoint_env,
            secondary_endpoint_digest, started_at, last_heartbeat_at
          ) VALUES (
            ${"00000000-0000-4000-8000-000000000099"}::uuid, 'running',
            'health-test', 'dual_provider', 'mainnet-beta', 'health-primary',
            'HEALTH_PRIMARY_RPC', ${"e".repeat(64)}, 'health-secondary',
            'HEALTH_SECONDARY_RPC', ${"f".repeat(64)},
            ${new Date(observedAt.getTime() - 120_000).toISOString()},
            ${new Date(observedAt.getTime() - 60_000).toISOString()}
          )
        `;
        await sql`
          UPDATE worker_job_states SET
            last_attempted_at = ${new Date(observedAt.getTime() - 60_000).toISOString()},
            last_succeeded_at = ${new Date(observedAt.getTime() - 60_000).toISOString()},
            last_attempt_instance_id = ${"00000000-0000-4000-8000-000000000099"}::uuid,
            last_success_instance_id = ${"00000000-0000-4000-8000-000000000099"}::uuid,
            interval_ms = 2_000
          WHERE name = 'ingest_watch_targets'
        `;
      },
    );
    await expect(
      store.enqueueScheduledSignals({
        organizationId,
        actorId: "worker",
        observedAt,
        rpc: healthRpc,
      }),
    ).resolves.toBe(2);
    await store.drainSignals({
      organizationId,
      actorId: "worker",
      processedAt: new Date(observedAt.getTime() + 1),
    });
    await expect(
      store.listIncidents({ organizationId, actorId: "operator", limit: 10 }),
    ).resolves.toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ kind: "worker_stale", state: "open" }),
        expect.objectContaining({ kind: "ingestion_gap", state: "open" }),
      ]),
    });

    const recoveredAt = new Date(observedAt.getTime() + 10_000);
    await database.transaction(
      { organizationId, actorId: "test" },
      async (sql) => {
        await sql`
          UPDATE worker_instances SET last_heartbeat_at = ${recoveredAt.toISOString()}
          WHERE id = ${"00000000-0000-4000-8000-000000000099"}::uuid
        `;
        await sql`
          UPDATE worker_job_states SET
            last_attempted_at = ${recoveredAt.toISOString()},
            last_succeeded_at = ${recoveredAt.toISOString()}
          WHERE name = 'ingest_watch_targets'
        `;
      },
    );
    await expect(
      store.enqueueScheduledSignals({
        organizationId,
        actorId: "worker",
        observedAt: recoveredAt,
        rpc: healthRpc,
      }),
    ).resolves.toBe(2);
    await store.drainSignals({
      organizationId,
      actorId: "worker",
      processedAt: new Date(recoveredAt.getTime() + 1),
    });
    const resolved = await store.listIncidents({
      organizationId,
      actorId: "operator",
      limit: 10,
    });
    expect(
      resolved.items.filter(({ kind }) =>
        ["worker_stale", "ingestion_gap"].includes(kind),
      ),
    ).toEqual([
      expect.objectContaining({ state: "resolved" }),
      expect.objectContaining({ state: "resolved" }),
    ]);
  });

  it("preserves observe-resolve-observe recurrence inside one bucket", async () => {
    const base = new Date("2026-08-13T12:00:10.000Z");
    await database.transaction(
      { organizationId, actorId: "test" },
      async (sql) => {
        await sql`
          INSERT INTO rpc_providers (
            id, cluster, endpoint_env, endpoint_label, active, created_at
          ) VALUES
            ('recurrence-primary', 'mainnet-beta', 'RECURRENCE_PRIMARY_RPC',
              'recurrence primary', true, now()),
            ('recurrence-secondary', 'mainnet-beta', 'RECURRENCE_SECONDARY_RPC',
              'recurrence secondary', true, now())
        `;
        await sql`
          INSERT INTO rpc_provider_roles (
            organization_id, cluster, role, provider_id, created_at
          ) VALUES
            (${organizationId}::uuid, 'mainnet-beta', 'primary',
              'recurrence-primary', now()),
            (${organizationId}::uuid, 'mainnet-beta', 'secondary',
              'recurrence-secondary', now())
        `;
        await sql`
          INSERT INTO worker_instances (
            id, state, build_revision, rpc_mode, rpc_cluster,
            primary_provider_id, primary_endpoint_env, primary_endpoint_digest,
            secondary_provider_id, secondary_endpoint_env,
            secondary_endpoint_digest, started_at, last_heartbeat_at
          ) VALUES (
            ${"00000000-0000-4000-8000-000000000097"}::uuid, 'running',
            'recurrence-test', 'dual_provider', 'mainnet-beta',
            'recurrence-primary', 'RECURRENCE_PRIMARY_RPC', ${"d".repeat(64)},
            'recurrence-secondary', 'RECURRENCE_SECONDARY_RPC',
            ${"e".repeat(64)},
            ${new Date(base.getTime() - 120_000).toISOString()},
            ${new Date(base.getTime() - 60_000).toISOString()}
          )
        `;
        await sql`
          UPDATE worker_job_states SET interval_ms = 2_000,
            last_attempt_instance_id = ${"00000000-0000-4000-8000-000000000097"}::uuid,
            last_success_instance_id = ${"00000000-0000-4000-8000-000000000097"}::uuid,
            last_attempted_at = ${new Date(base.getTime() - 60_000).toISOString()},
            last_succeeded_at = ${new Date(base.getTime() - 60_000).toISOString()}
          WHERE name = 'ingest_watch_targets'
        `;
      },
    );
    for (const [offset, healthy] of [
      [0, false],
      [10_000, true],
      [20_000, false],
    ] as const) {
      const at = new Date(base.getTime() + offset);
      if (healthy) {
        await database.transaction(
          { organizationId, actorId: "test" },
          async (sql) => {
            await sql`
              UPDATE worker_instances SET last_heartbeat_at = ${at.toISOString()}
              WHERE id = ${"00000000-0000-4000-8000-000000000097"}::uuid
            `;
            await sql`
              UPDATE worker_job_states SET
                last_attempted_at = ${at.toISOString()},
                last_succeeded_at = ${at.toISOString()}
              WHERE name = 'ingest_watch_targets'
            `;
          },
        );
      } else if (offset > 0) {
        await database.transaction(
          { organizationId, actorId: "test" },
          async (sql) => {
            await sql`
              UPDATE worker_instances SET last_heartbeat_at =
                ${new Date(at.getTime() - 60_000).toISOString()}
              WHERE id = ${"00000000-0000-4000-8000-000000000097"}::uuid
            `;
            await sql`
              UPDATE worker_job_states SET
                last_attempted_at =
                  ${new Date(at.getTime() - 60_000).toISOString()},
                last_succeeded_at =
                  ${new Date(at.getTime() - 60_000).toISOString()}
              WHERE name = 'ingest_watch_targets'
            `;
          },
        );
      }
      await store.enqueueScheduledSignals({
        organizationId,
        actorId: "worker",
        observedAt: at,
        rpc: recurrenceRpc,
      });
      await store.drainSignals({
        organizationId,
        actorId: "worker",
        processedAt: new Date(at.getTime() + 1),
      });
    }
    const incidents = await store.listIncidents({
      organizationId,
      actorId: "operator",
      limit: 10,
    });
    for (const kind of ["worker_stale", "ingestion_gap"] as const) {
      expect(
        incidents.items.filter((incident) => incident.kind === kind),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ state: "open" }),
          expect.objectContaining({ state: "resolved" }),
        ]),
      );
    }
  });
});

function withSearchPath(databaseUrl: string, targetSchema: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set("options", `-c search_path=${targetSchema}`);
  return url.toString();
}

function responseCommitter(
  claim: Extract<
    Awaited<ReturnType<IdempotencyStore["claim"]>>,
    { readonly kind: "execute" }
  >,
  completedAt: Date,
): IdempotencyResponseCommitter {
  return {
    complete: async (transaction, status, body) => {
      await completeIdempotency(transaction, {
        organizationId,
        recordId: claim.recordId,
        leaseToken: claim.leaseToken,
        status,
        contentType: "application/json; charset=utf-8",
        body: Buffer.from(canonicalJson(body), "utf8"),
        completedAt,
      });
    },
  };
}

function publicIncidentResponse(value: {
  readonly id: string;
  readonly state: string;
  readonly version: number;
}) {
  return { id: value.id, state: value.state, version: value.version };
}
