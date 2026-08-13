import { randomUUID } from "node:crypto";
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
  persistedProductionPromotionEvaluator,
  ProductionControlStore,
  type IdempotencyResponseCommitter,
  type PromotionResult,
  type PromotionPrerequisites,
} from "../src/index.js";
import {
  cleanupTestProductionRoles,
  runTestPlatformMigrations,
} from "./production-role-test-helper.js";

const baseDatabaseUrl = process.env.DATABASE_URL;
const describeDatabase = baseDatabaseUrl ? describe : describe.skip;
const schema = `payops_production_control_${process.pid}`;
const databaseUrl = baseDatabaseUrl
  ? withSearchPath(baseDatabaseUrl, schema)
  : undefined;
const admin = baseDatabaseUrl
  ? postgres(baseDatabaseUrl, { max: 1, onnotice: () => undefined })
  : undefined;
const scoped = databaseUrl
  ? postgres(databaseUrl, { max: 1, onnotice: () => undefined })
  : undefined;
const organizationId = "00000000-0000-4000-8000-000000000001";
const secondOrganizationId = "00000000-0000-4000-8000-000000000002";
const readerRole = `payops_production_reader_${process.pid}`;
const forgerRole = `payops_production_forger_${process.pid}`;
const productionPromotionRpc = {
  mode: "dual_provider" as const,
  cluster: "mainnet-beta" as const,
  primaryProviderId: "promotion-primary",
  primaryEndpointEnvironment: "PRIMARY_RPC",
  primaryEndpointDigest: "a".repeat(64),
  secondaryProviderId: "promotion-secondary",
  secondaryEndpointEnvironment: "SECONDARY_RPC",
  secondaryEndpointDigest: "b".repeat(64),
};

describeDatabase("production controls", () => {
  let database: OrganizationDatabase;
  let prerequisites: PromotionPrerequisites;

  beforeAll(async () => {
    await admin!.unsafe(`CREATE SCHEMA ${schema}`);
    await admin!.unsafe(`CREATE ROLE ${readerRole} NOLOGIN`);
    await admin!.unsafe(`CREATE ROLE ${forgerRole} NOLOGIN`);
  });

  beforeEach(async () => {
    await database?.close();
    await admin!.unsafe(`DROP SCHEMA ${schema} CASCADE`);
    await admin!.unsafe(`CREATE SCHEMA ${schema}`);
    await runIngestionMigrations(databaseUrl!);
    await runReconciliationMigrations(databaseUrl!);
    await runTestPlatformMigrations(databaseUrl!);
    await admin!.unsafe(`GRANT USAGE ON SCHEMA ${schema} TO ${forgerRole}`);
    await admin!.unsafe(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ${schema}.organization_production_controls TO ${forgerRole}`,
    );
    await admin!.unsafe(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ${schema}.operational_incidents, ${schema}.operational_incident_events, ${schema}.operational_health_signals TO ${forgerRole}`,
    );
    database = new OrganizationDatabase(databaseUrl!, { max: 2 });
    prerequisites = {
      completeWatchCoverage: false,
      freshWorkerHeartbeat: false,
      twoActiveProductionRpcRoles: false,
      noOpenCriticalIncident: false,
    };
  });

  afterAll(async () => {
    await database?.close();
    await admin!.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await cleanupTestProductionRoles(databaseUrl!);
    await admin!.unsafe(`DROP ROLE IF EXISTS ${readerRole}`);
    await admin!.unsafe(`DROP ROLE IF EXISTS ${forgerRole}`);
    await scoped?.end();
    await admin?.end();
  });

  it("defaults every organization to shadow and isolates controls with forced RLS", async () => {
    await scoped!`
      SELECT set_config('payops.organization_id', ${secondOrganizationId}, false)
    `;
    await scoped!`
      INSERT INTO organization (id, name, slug, created_at)
      VALUES (${secondOrganizationId}::uuid, 'Second', 'second', now())
    `;
    const store = productionControlStore(database, () => prerequisites);

    await expect(
      store.getStatus({ organizationId, actorId: "operator" }),
    ).resolves.toMatchObject({
      organizationId,
      activationMode: "shadow",
      version: 1,
      promotedAt: null,
      promotedBy: null,
    });
    await expect(
      store.getStatus({
        organizationId: secondOrganizationId,
        actorId: "operator",
      }),
    ).resolves.toMatchObject({
      organizationId: secondOrganizationId,
      activationMode: "shadow",
    });

    await scoped!.unsafe(`GRANT USAGE ON SCHEMA ${schema} TO ${readerRole}`);
    await scoped!.unsafe(
      `GRANT SELECT ON organization_production_controls, shadow_projection_decisions TO ${readerRole}`,
    );
    await scoped!.unsafe(`SET ROLE ${readerRole}`);
    try {
      await scoped!`SELECT set_config('payops.organization_id', ${organizationId}, false)`;
      const first = await scoped!<{ organization_id: string }[]>`
        SELECT organization_id::text FROM organization_production_controls
      `;
      expect(first).toEqual([{ organization_id: organizationId }]);

      await scoped!`SELECT set_config('payops.organization_id', ${secondOrganizationId}, false)`;
      const second = await scoped!<{ organization_id: string }[]>`
        SELECT organization_id::text FROM organization_production_controls
      `;
      expect(second).toEqual([{ organization_id: secondOrganizationId }]);
    } finally {
      await scoped!.unsafe(`RESET ROLE`);
    }
  });

  it("cannot promote across a concurrently committed critical incident", async () => {
    const promotionUrl = new URL(databaseUrl!);
    promotionUrl.searchParams.set("application_name", "task4-promotion-race");
    const promotionDatabase = new OrganizationDatabase(
      promotionUrl.toString(),
      {
        max: 2,
      },
    );
    let releaseIncident!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseIncident = resolve;
    });
    let incidentObserved!: () => void;
    const observed = new Promise<void>((resolve) => {
      incidentObserved = resolve;
    });
    const incidentTransaction = database.transaction(
      { organizationId, actorId: "health-worker" },
      async (sql) => {
        await sql`
          SELECT payops_observe_operational_incident(
            ${organizationId}::uuid, 'system', 'rpc_disagreement', 'critical',
            ${"a".repeat(64)}, clock_timestamp()
          )
        `;
        incidentObserved();
        await release;
      },
    );
    await observed;

    try {
      const store = productionControlStore(promotionDatabase, () => ({
        completeWatchCoverage: true,
        freshWorkerHeartbeat: true,
        twoActiveProductionRpcRoles: true,
        noOpenCriticalIncident: true,
      }));
      const promotion = store.promoteLive({
        organizationId,
        actorId: "operator",
        actorKind: "session",
        auditRequestId: randomUUID(),
        expectedVersion: 1,
        now: new Date(),
      });
      try {
        await waitForAdvisoryLockWait();
      } finally {
        releaseIncident();
        await incidentTransaction;
      }

      await expect(promotion).resolves.toMatchObject({
        outcome: "blocked",
        evaluation: {
          prerequisites: { noOpenCriticalIncident: false },
          blockers: ["open_critical_incident"],
        },
      });
      await expect(
        store.getStatus({ organizationId, actorId: "operator" }),
      ).resolves.toMatchObject({ activationMode: "shadow" });
    } finally {
      await promotionDatabase.close();
    }
  });

  it("evaluates all prerequisites in-transaction and promotes exactly once with audit", async () => {
    const store = productionControlStore(database, () => prerequisites);
    const now = new Date();

    await expect(
      store.evaluatePromotion({ organizationId, actorId: "operator", now }),
    ).resolves.toEqual({
      eligible: false,
      blockers: [
        "watch_coverage_incomplete",
        "worker_heartbeat_stale",
        "production_rpc_roles_incomplete",
        "open_critical_incident",
      ],
      prerequisites,
    });
    await expect(
      store.promoteLive({
        organizationId,
        actorKind: "session",
        actorId: "operator",
        auditRequestId: randomUUID(),
        expectedVersion: 1,
        now,
      }),
    ).resolves.toMatchObject({ outcome: "blocked" });

    prerequisites = {
      completeWatchCoverage: true,
      freshWorkerHeartbeat: true,
      twoActiveProductionRpcRoles: true,
      noOpenCriticalIncident: true,
    };
    const requestId = randomUUID();
    await expect(
      store.promoteLive({
        organizationId,
        actorKind: "session",
        actorId: "operator",
        auditRequestId: requestId,
        expectedVersion: 1,
        now,
      }),
    ).resolves.toMatchObject({
      outcome: "promoted",
      status: {
        activationMode: "live",
        version: 2,
        promotedAt: now.toISOString(),
        promotedBy: "operator",
      },
    });
    await expect(
      store.promoteLive({
        organizationId,
        actorKind: "session",
        actorId: "operator",
        auditRequestId: requestId,
        expectedVersion: 1,
        now,
      }),
    ).resolves.toMatchObject({ outcome: "already_live" });

    const evidence = await database.transaction(
      { organizationId, actorId: "test" },
      async (sql) => {
        const successful = await sql<{ count: number }[]>`
          SELECT count(*)::integer AS count FROM audit_events
          WHERE action = 'production_control.promote'
            AND outcome = 'succeeded'
        `;
        const rejected = await sql<{ count: number }[]>`
          SELECT count(*)::integer AS count FROM audit_events
          WHERE action = 'production_control.promote'
            AND outcome = 'rejected'
        `;
        return {
          successful: successful[0]!.count,
          rejected: rejected[0]!.count,
        };
      },
    );
    expect(evidence).toEqual({ successful: 1, rejected: 1 });
  });

  it("atomically records the promoted response for crash-window replay", async () => {
    const store = productionControlStore(database, () => ({
      completeWatchCoverage: true,
      freshWorkerHeartbeat: true,
      twoActiveProductionRpcRoles: true,
      noOpenCriticalIncident: true,
    }));
    const actorId = "owner-session";
    const now = new Date();
    const idempotency = new IdempotencyStore(database);
    const identity = {
      organizationId,
      actorKind: "session" as const,
      actorId,
      routeId: "operations.production.promote",
      key: "promotion-crash-window-0001",
      requestDigest: digestIdempotentRequest({
        method: "POST",
        routeId: "operations.production.promote",
        path: {},
        body: { confirmed: true, expectedVersion: 1 },
      }),
    };
    const claim = await idempotency.claim(identity, now);
    if (claim.kind !== "execute") throw new Error("expected execution lease");

    const promoted = await store.promoteLive({
      organizationId,
      actorKind: "session",
      actorId,
      auditRequestId: randomUUID(),
      expectedVersion: 1,
      now,
      idempotency: {
        committer: promotionResponseCommitter(claim, now),
        response: promotionResponse,
      },
    });

    expect(promoted).toMatchObject({ outcome: "promoted" });
    const replay = await idempotency.claim(
      identity,
      new Date(now.getTime() + 1_000),
    );
    expect(replay).toMatchObject({ kind: "replay", status: 200 });
    if (replay.kind !== "replay") throw new Error("expected replay");
    expect(Buffer.from(replay.body).toString("utf8")).toBe(
      canonicalJson(promotionResponse(promoted).body),
    );
    await database.transaction({ organizationId, actorId }, async (sql) => {
      const [audit] = await sql<{ count: number }[]>`
          SELECT count(*)::integer AS count FROM audit_events
          WHERE action = 'production_control.promote'
        `;
      expect(audit?.count).toBe(1);
    });
  });

  it("atomically records blocked promotion responses", async () => {
    const store = productionControlStore(database, () => ({
      completeWatchCoverage: false,
      freshWorkerHeartbeat: false,
      twoActiveProductionRpcRoles: false,
      noOpenCriticalIncident: true,
    }));
    const actorId = "owner-session";
    const now = new Date();
    const idempotency = new IdempotencyStore(database);
    const identity = {
      organizationId,
      actorKind: "session" as const,
      actorId,
      routeId: "operations.production.promote",
      key: "promotion-blocked-atomic-0001",
      requestDigest: digestIdempotentRequest({
        method: "POST",
        routeId: "operations.production.promote",
        path: {},
        body: { confirmed: true, expectedVersion: 1 },
      }),
    };
    const claim = await idempotency.claim(identity, now);
    if (claim.kind !== "execute") throw new Error("expected execution lease");
    const blocked = await store.promoteLive({
      organizationId,
      actorKind: "session",
      actorId,
      auditRequestId: randomUUID(),
      expectedVersion: 1,
      now,
      idempotency: {
        committer: promotionResponseCommitter(claim, now),
        response: promotionResponse,
      },
    });

    expect(blocked).toMatchObject({ outcome: "blocked" });
    const replay = await idempotency.claim(
      identity,
      new Date(now.getTime() + 1_000),
    );
    expect(replay).toMatchObject({ kind: "replay", status: 409 });
    if (replay.kind !== "replay") throw new Error("expected replay");
    expect(Buffer.from(replay.body).toString("utf8")).toBe(
      canonicalJson(promotionResponse(blocked).body),
    );
    await database.transaction({ organizationId, actorId }, async (sql) => {
      const [audit] = await sql<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM audit_events
        WHERE action = 'production_control.promote'
      `;
      expect(audit?.count).toBe(1);
    });
  });

  it("atomically records already-live responses without duplicate audit", async () => {
    const store = productionControlStore(database, () => ({
      completeWatchCoverage: true,
      freshWorkerHeartbeat: true,
      twoActiveProductionRpcRoles: true,
      noOpenCriticalIncident: true,
    }));
    const actorId = "owner-session";
    const now = new Date();
    await store.promoteLive({
      organizationId,
      actorKind: "session",
      actorId,
      auditRequestId: randomUUID(),
      expectedVersion: 1,
      now,
    });
    const idempotency = new IdempotencyStore(database);
    const identity = {
      organizationId,
      actorKind: "session" as const,
      actorId,
      routeId: "operations.production.promote",
      key: "promotion-already-live-atomic-01",
      requestDigest: digestIdempotentRequest({
        method: "POST",
        routeId: "operations.production.promote",
        path: {},
        body: { confirmed: true, expectedVersion: 1 },
      }),
    };
    const claimedAt = new Date(now.getTime() + 1_000);
    const claim = await idempotency.claim(identity, claimedAt);
    if (claim.kind !== "execute") throw new Error("expected execution lease");
    const alreadyLive = await store.promoteLive({
      organizationId,
      actorKind: "session",
      actorId,
      auditRequestId: randomUUID(),
      expectedVersion: 1,
      now: claimedAt,
      idempotency: {
        committer: promotionResponseCommitter(claim, claimedAt),
        response: promotionResponse,
      },
    });

    expect(alreadyLive).toMatchObject({ outcome: "already_live" });
    const replay = await idempotency.claim(
      identity,
      new Date(claimedAt.getTime() + 1_000),
    );
    expect(replay).toMatchObject({ kind: "replay", status: 200 });
    if (replay.kind !== "replay") throw new Error("expected replay");
    expect(Buffer.from(replay.body).toString("utf8")).toBe(
      canonicalJson(promotionResponse(alreadyLive).body),
    );
    await database.transaction({ organizationId, actorId }, async (sql) => {
      const [audit] = await sql<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM audit_events
        WHERE action = 'production_control.promote'
      `;
      expect(audit?.count).toBe(1);
    });
  });

  it("rolls back promotion when atomic response completion fails", async () => {
    const store = productionControlStore(database, () => ({
      completeWatchCoverage: true,
      freshWorkerHeartbeat: true,
      twoActiveProductionRpcRoles: true,
      noOpenCriticalIncident: true,
    }));
    const failingCommitter: IdempotencyResponseCommitter = {
      complete: async () => {
        throw new Error("simulated response commit failure");
      },
    };

    await expect(
      store.promoteLive({
        organizationId,
        actorKind: "session",
        actorId: "owner-session",
        auditRequestId: randomUUID(),
        expectedVersion: 1,
        now: new Date(),
        idempotency: {
          committer: failingCommitter,
          response: promotionResponse,
        },
      }),
    ).rejects.toThrow("simulated response commit failure");
    await expect(
      store.getStatus({ organizationId, actorId: "owner-session" }),
    ).resolves.toMatchObject({ activationMode: "shadow", version: 1 });
  });

  it("atomically records deterministic promotion version conflicts", async () => {
    const store = productionControlStore(database, () => ({
      completeWatchCoverage: true,
      freshWorkerHeartbeat: true,
      twoActiveProductionRpcRoles: true,
      noOpenCriticalIncident: true,
    }));
    const actorId = "owner-session";
    const now = new Date();
    const idempotency = new IdempotencyStore(database);
    const identity = {
      organizationId,
      actorKind: "session" as const,
      actorId,
      routeId: "operations.production.promote",
      key: "promotion-version-conflict-0001",
      requestDigest: digestIdempotentRequest({
        method: "POST",
        routeId: "operations.production.promote",
        path: {},
        body: { confirmed: true, expectedVersion: 99 },
      }),
    };
    const claim = await idempotency.claim(identity, now);
    if (claim.kind !== "execute") throw new Error("expected execution lease");
    const response = {
      code: "production_control_version_conflict",
      message: "Operation could not be completed",
    };

    await expect(
      store.promoteLive({
        organizationId,
        actorKind: "session",
        actorId,
        auditRequestId: randomUUID(),
        expectedVersion: 99,
        now,
        idempotency: {
          committer: promotionResponseCommitter(claim, now),
          response: promotionResponse,
          errorResponse: () => ({ status: 409, body: response }),
        },
      }),
    ).rejects.toMatchObject({
      code: "production_control_version_conflict",
      idempotencyCompleted: true,
    });
    const replay = await idempotency.claim(
      identity,
      new Date(now.getTime() + 1_000),
    );
    expect(replay).toMatchObject({ kind: "replay", status: 409 });
    if (replay.kind !== "replay") throw new Error("expected replay");
    expect(Buffer.from(replay.body).toString("utf8")).toBe(
      canonicalJson(response),
    );
  });

  it("rejects direct SQL promotion after a DML role sets the old guard GUC", async () => {
    const store = productionControlStore(database, () => prerequisites);
    await store.getStatus({ organizationId, actorId: "operator" });
    const promotedAt = new Date("2026-08-12T13:00:00.000Z");

    await expect(
      database.transaction(
        { organizationId, actorId: "forger" },
        async (sql) => {
          await sql.unsafe(`SET LOCAL ROLE ${forgerRole}`);
          await sql`
            SELECT set_config(
              'payops.production_control_operation', 'promote_live', true
            )
          `;
          return sql`
            SELECT * FROM payops_promote_production_control(
              ${organizationId}::uuid, 1,
              ${promotedAt.toISOString()}::timestamptz, 'forger'
            )
          `;
        },
      ),
    ).rejects.toMatchObject({ code: "42883" });

    await expect(
      database.transaction(
        { organizationId, actorId: "forger" },
        async (sql) => {
          await sql.unsafe(`SET LOCAL ROLE ${forgerRole}`);
          await sql`
            SELECT set_config(
              'payops.production_control_operation', 'promote_live', true
            )
          `;
          return sql`
            UPDATE organization_production_controls
            SET activation_mode = 'live', version = 2,
              promoted_at = now(), promoted_by = 'forger', updated_at = now()
            WHERE organization_id = ${organizationId}::uuid
          `;
        },
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects incident mutation and forged history even for a DML-capable role", async () => {
    const incident = await new OperationalHealthStore(database).observeIncident(
      {
        organizationId,
        actorId: "health-worker",
        actorKind: "system",
        kind: "rpc_disagreement",
        severity: "critical",
        scopeKey: "d".repeat(64),
        observedAt: new Date(),
      },
    );
    await scoped!.unsafe(`SET ROLE ${forgerRole}`);
    try {
      await scoped!`
        SELECT set_config('payops.organization_id', ${organizationId}, false)
      `;
      await expect(scoped!`
        UPDATE operational_incidents SET occurrence_count = 999
        WHERE id = ${incident.id}::uuid
      `).rejects.toMatchObject({ code: "23514" });
      await expect(scoped!`
        DELETE FROM operational_incidents WHERE id = ${incident.id}::uuid
      `).rejects.toMatchObject({ code: "23514" });
      await expect(scoped!`
        INSERT INTO operational_incident_events (
          id, organization_id, incident_id, incident_version, action,
          from_state, to_state, occurrence_count, actor_kind,
          occurred_at, created_at
        ) VALUES (
          ${randomUUID()}::uuid, ${organizationId}::uuid, ${incident.id}::uuid,
          2, 'reobserved', 'open', 'open', 999, 'system', now(), now()
        )
      `).rejects.toMatchObject({ code: "23514" });
      await expect(scoped!`
        INSERT INTO operational_health_signals (
          organization_id, dedupe_key, measurement_kind, measurement_value,
          observed_at
        ) VALUES (
          ${organizationId}::uuid, ${"e".repeat(64)},
          'rpc_consensus_checks', 1, now()
        )
      `).rejects.toMatchObject({ code: "23514" });
    } finally {
      await scoped!.unsafe("RESET ROLE");
    }
    await expect(
      database.transaction(
        { organizationId, actorId: "test" },
        async (sql) => sql`
          SELECT occurrence_count, version,
            (SELECT count(*)::integer FROM operational_incident_events
              WHERE incident_id = ${incident.id}::uuid) AS event_count
          FROM operational_incidents WHERE id = ${incident.id}::uuid
        `,
      ),
    ).resolves.toEqual([{ occurrence_count: 1, version: 1, event_count: 1 }]);
  });

  it("rejects direct SQL promotion by the runtime migration role", async () => {
    const store = productionControlStore(database, () => prerequisites);
    await store.getStatus({ organizationId, actorId: "operator" });

    await expect(
      database.transaction(
        { organizationId, actorId: "runtime" },
        async (sql) => sql`
          UPDATE organization_production_controls
          SET activation_mode = 'live', version = 2,
            promoted_at = now(), promoted_by = 'runtime', updated_at = now()
          WHERE organization_id = ${organizationId}::uuid
        `,
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("evaluates persisted worker readiness and provider roles without external calls", async () => {
    const store = new ProductionControlStore(
      database,
      persistedProductionPromotionEvaluator,
      { rpc: productionPromotionRpc },
    );
    const now = new Date();
    await expect(
      store.evaluatePromotion({ organizationId, actorId: "operator", now }),
    ).resolves.toMatchObject({
      eligible: false,
      prerequisites: {
        completeWatchCoverage: false,
        freshWorkerHeartbeat: false,
        twoActiveProductionRpcRoles: false,
        noOpenCriticalIncident: true,
      },
    });

    await scoped!`
      INSERT INTO rpc_providers (
        id, cluster, endpoint_env, endpoint_label, active, created_at
      ) VALUES
        ('promotion-primary', 'mainnet-beta', 'PRIMARY_RPC', 'primary', true, now()),
        ('promotion-secondary', 'mainnet-beta', 'SECONDARY_RPC', 'secondary', true, now())
    `;
    await database.transaction(
      { organizationId, actorId: "test" },
      async (sql) => {
        await sql`
          INSERT INTO rpc_provider_roles (
            organization_id, cluster, role, provider_id, created_at
          ) VALUES
            (${organizationId}::uuid, 'mainnet-beta', 'primary',
              'promotion-primary', now()),
            (${organizationId}::uuid, 'mainnet-beta', 'secondary',
              'promotion-secondary', now())
        `;
        await sql`
          INSERT INTO watch_targets (
            id, provider_id, cluster, address, cutover_slot, overlap_slots,
            coverage, active, created_at, organization_id
          ) VALUES (
            'promotion-watch', 'promotion-primary', 'mainnet-beta',
            '11111111111111111111111111111111', 0, 64, 'complete', true,
            now(), ${organizationId}::uuid
          )
        `;
      },
    );
    await scoped!`
      INSERT INTO worker_instances (
        id, state, build_revision, rpc_mode, rpc_cluster,
        primary_provider_id, primary_endpoint_env, primary_endpoint_digest,
        secondary_provider_id, secondary_endpoint_env,
        secondary_endpoint_digest,
        started_at, last_heartbeat_at
      ) VALUES (
        '00000000-0000-4000-8000-000000000099'::uuid,
        'running', 'promotion-test', 'single_provider', 'mainnet-beta',
        'promotion-primary', 'PRIMARY_RPC', ${"a".repeat(64)},
        NULL, NULL, NULL, clock_timestamp(), clock_timestamp()
      )
    `;
    await scoped!`
      UPDATE worker_job_states SET interval_ms = 2000,
        last_attempted_at = clock_timestamp(),
        last_succeeded_at = clock_timestamp(), attempts = 1, successes = 1,
        last_attempt_instance_id =
          '00000000-0000-4000-8000-000000000099'::uuid,
        last_success_instance_id =
          '00000000-0000-4000-8000-000000000099'::uuid
      WHERE lifecycle = 'active'
    `;

    await expect(
      store.evaluatePromotion({ organizationId, actorId: "operator", now }),
    ).resolves.toMatchObject({
      eligible: false,
      blockers: ["worker_heartbeat_stale"],
      prerequisites: {
        freshWorkerHeartbeat: false,
        twoActiveProductionRpcRoles: true,
      },
    });

    await scoped!`
      UPDATE worker_instances
      SET rpc_mode = 'dual_provider', secondary_provider_id = 'wrong-secondary',
        secondary_endpoint_env = 'WRONG_SECONDARY_RPC',
        secondary_endpoint_digest = ${"b".repeat(64)}
      WHERE id = '00000000-0000-4000-8000-000000000099'::uuid
    `;
    await expect(
      store.evaluatePromotion({ organizationId, actorId: "operator", now }),
    ).resolves.toMatchObject({
      eligible: false,
      blockers: ["worker_heartbeat_stale"],
      prerequisites: { freshWorkerHeartbeat: false },
    });

    await scoped!`
      UPDATE worker_instances
      SET secondary_provider_id = 'promotion-secondary',
        secondary_endpoint_env =
          ${productionPromotionRpc.secondaryEndpointEnvironment},
        secondary_endpoint_digest =
          ${productionPromotionRpc.secondaryEndpointDigest}
      WHERE id = '00000000-0000-4000-8000-000000000099'::uuid
    `;
    await expect(
      store.evaluatePromotion({ organizationId, actorId: "operator", now }),
    ).resolves.toEqual({
      eligible: true,
      blockers: [],
      prerequisites: {
        completeWatchCoverage: true,
        freshWorkerHeartbeat: true,
        twoActiveProductionRpcRoles: true,
        noOpenCriticalIncident: true,
      },
    });

    await scoped!`
      UPDATE worker_instances
      SET primary_endpoint_digest = ${"f".repeat(64)}
      WHERE id = '00000000-0000-4000-8000-000000000099'::uuid
    `;
    await expect(
      store.evaluatePromotion({ organizationId, actorId: "operator", now }),
    ).resolves.toMatchObject({
      eligible: false,
      blockers: ["worker_heartbeat_stale"],
    });
    await scoped!`
      UPDATE worker_instances
      SET primary_endpoint_digest = ${productionPromotionRpc.primaryEndpointDigest}
      WHERE id = '00000000-0000-4000-8000-000000000099'::uuid
    `;

    await scoped!`
      INSERT INTO worker_instances (
        id, state, build_revision, rpc_mode, rpc_cluster,
        primary_provider_id, primary_endpoint_env, primary_endpoint_digest,
        secondary_provider_id, secondary_endpoint_env,
        secondary_endpoint_digest,
        started_at, last_heartbeat_at
      ) VALUES (
        '00000000-0000-4000-8000-000000000098'::uuid,
        'running', 'mismatched-worker', 'dual_provider', 'mainnet-beta',
        'promotion-primary', 'PRIMARY_RPC', ${"a".repeat(64)},
        'wrong-secondary', 'WRONG_SECONDARY_RPC', ${"b".repeat(64)},
        clock_timestamp(), clock_timestamp()
      )
    `;
    await scoped!`
      UPDATE worker_job_states SET
        last_attempted_at = clock_timestamp(),
        last_attempt_instance_id =
          '00000000-0000-4000-8000-000000000098'::uuid,
        lease_token = gen_random_uuid(),
        lease_expires_at = clock_timestamp() + interval '1 minute',
        lease_owner_id = '00000000-0000-4000-8000-000000000098'::uuid
      WHERE name = 'project_payment_status'
    `;
    await expect(
      store.evaluatePromotion({ organizationId, actorId: "operator", now }),
    ).resolves.toMatchObject({
      eligible: false,
      blockers: ["worker_heartbeat_stale"],
    });

    await scoped!`
      UPDATE worker_job_states SET
        lease_token = NULL, lease_expires_at = NULL, lease_owner_id = NULL,
        last_completed_at = clock_timestamp()
      WHERE name = 'project_payment_status'
    `;
    await expect(
      store.evaluatePromotion({ organizationId, actorId: "operator", now }),
    ).resolves.toMatchObject({
      eligible: false,
      blockers: ["worker_heartbeat_stale"],
    });

    await scoped!`
      UPDATE worker_job_states SET
        lease_token = NULL, lease_expires_at = NULL, lease_owner_id = NULL,
        last_attempt_instance_id =
          '00000000-0000-4000-8000-000000000099'::uuid
      WHERE name = 'project_payment_status'
    `;

    await expect(
      scoped!`
        UPDATE worker_job_states SET lifecycle = 'active'
        WHERE name = 'reconcile_attempts'
      `,
    ).rejects.toThrow();
    await expect(
      store.evaluatePromotion({ organizationId, actorId: "operator", now }),
    ).resolves.toMatchObject({ eligible: true, blockers: [] });
  });

  it("fails promotion closed for an active legacy lease without an owner", async () => {
    const store = new ProductionControlStore(
      database,
      persistedProductionPromotionEvaluator,
      { rpc: productionPromotionRpc },
    );
    const now = new Date();
    await seedPersistedPromotionReadiness(database);

    await expect(
      store.evaluatePromotion({ organizationId, actorId: "operator", now }),
    ).resolves.toMatchObject({ eligible: true, blockers: [] });

    await scoped!`
      UPDATE worker_job_states SET
        lease_token = gen_random_uuid(),
        lease_expires_at = clock_timestamp() + interval '1 minute',
        lease_owner_id = NULL
      WHERE name = 'project_payment_status'
    `;
    await expect(
      store.evaluatePromotion({ organizationId, actorId: "operator", now }),
    ).resolves.toMatchObject({
      eligible: false,
      blockers: ["worker_heartbeat_stale"],
    });
  });

  it("fails promotion closed for stale matching latest-attempt and active-lease owners", async () => {
    const store = new ProductionControlStore(
      database,
      persistedProductionPromotionEvaluator,
      { rpc: productionPromotionRpc },
    );
    const now = new Date();
    await seedPersistedPromotionReadiness(database);
    await scoped!`
      INSERT INTO worker_instances (
        id, state, build_revision, rpc_mode, rpc_cluster,
        primary_provider_id, primary_endpoint_env, primary_endpoint_digest,
        secondary_provider_id, secondary_endpoint_env,
        secondary_endpoint_digest,
        started_at, last_heartbeat_at
      ) VALUES (
        '00000000-0000-4000-8000-000000000097'::uuid,
        'running', 'stale-attempt', 'dual_provider', 'mainnet-beta',
        ${productionPromotionRpc.primaryProviderId},
        ${productionPromotionRpc.primaryEndpointEnvironment},
        ${productionPromotionRpc.primaryEndpointDigest},
        ${productionPromotionRpc.secondaryProviderId},
        ${productionPromotionRpc.secondaryEndpointEnvironment},
        ${productionPromotionRpc.secondaryEndpointDigest},
        clock_timestamp() - interval '3 minutes',
        clock_timestamp() - interval '2 minutes'
      )
    `;
    await scoped!`
      UPDATE worker_job_states SET
        last_attempted_at = clock_timestamp(),
        last_attempt_instance_id =
          '00000000-0000-4000-8000-000000000097'::uuid,
        lease_token = gen_random_uuid(),
        lease_expires_at = clock_timestamp() + interval '1 minute',
        lease_owner_id = '00000000-0000-4000-8000-000000000097'::uuid
      WHERE name = 'project_payment_status'
    `;

    await expect(
      store.evaluatePromotion({ organizationId, actorId: "operator", now }),
    ).resolves.toMatchObject({
      eligible: false,
      blockers: ["worker_heartbeat_stale"],
    });
    await scoped!`
      UPDATE worker_job_states SET
        lease_token = NULL, lease_expires_at = NULL, lease_owner_id = NULL
      WHERE name = 'project_payment_status'
    `;
    await expect(
      store.evaluatePromotion({ organizationId, actorId: "operator", now }),
    ).resolves.toMatchObject({
      eligible: false,
      blockers: ["worker_heartbeat_stale"],
    });
  });
});

async function seedPersistedPromotionReadiness(
  database: OrganizationDatabase,
): Promise<void> {
  await scoped!`
    INSERT INTO rpc_providers (
      id, cluster, endpoint_env, endpoint_label, active, created_at
    ) VALUES
      ('promotion-primary', 'mainnet-beta', 'PRIMARY_RPC', 'primary', true, now()),
      ('promotion-secondary', 'mainnet-beta', 'SECONDARY_RPC', 'secondary', true, now())
  `;
  await database.transaction(
    { organizationId, actorId: "test" },
    async (sql) => {
      await sql`
        INSERT INTO rpc_provider_roles (
          organization_id, cluster, role, provider_id, created_at
        ) VALUES
          (${organizationId}::uuid, 'mainnet-beta', 'primary',
            'promotion-primary', now()),
          (${organizationId}::uuid, 'mainnet-beta', 'secondary',
            'promotion-secondary', now())
      `;
      await sql`
        INSERT INTO watch_targets (
          id, provider_id, cluster, address, cutover_slot, overlap_slots,
          coverage, active, created_at, organization_id
        ) VALUES (
          'promotion-watch', 'promotion-primary', 'mainnet-beta',
          '11111111111111111111111111111111', 0, 64, 'complete', true,
          now(), ${organizationId}::uuid
        )
      `;
    },
  );
  await scoped!`
    INSERT INTO worker_instances (
      id, state, build_revision, rpc_mode, rpc_cluster,
      primary_provider_id, primary_endpoint_env, primary_endpoint_digest,
      secondary_provider_id, secondary_endpoint_env,
      secondary_endpoint_digest,
      started_at, last_heartbeat_at
    ) VALUES (
      '00000000-0000-4000-8000-000000000099'::uuid,
      'running', 'promotion-test', 'dual_provider', 'mainnet-beta',
      ${productionPromotionRpc.primaryProviderId},
      ${productionPromotionRpc.primaryEndpointEnvironment},
      ${productionPromotionRpc.primaryEndpointDigest},
      ${productionPromotionRpc.secondaryProviderId},
      ${productionPromotionRpc.secondaryEndpointEnvironment},
      ${productionPromotionRpc.secondaryEndpointDigest},
      clock_timestamp(), clock_timestamp()
    )
  `;
  await scoped!`
    UPDATE worker_job_states SET interval_ms = 2000,
      last_attempted_at = clock_timestamp(),
      last_succeeded_at = clock_timestamp(), attempts = 1, successes = 1,
      last_attempt_instance_id =
        '00000000-0000-4000-8000-000000000099'::uuid,
      last_success_instance_id =
        '00000000-0000-4000-8000-000000000099'::uuid
    WHERE lifecycle = 'active'
  `;
}

function productionControlStore(
  database: OrganizationDatabase,
  snapshot: () => PromotionPrerequisites,
): ProductionControlStore {
  return new ProductionControlStore(database, {
    evaluate: async (sql, input) => {
      const rows = await sql<{ activation_mode: string }[]>`
        SELECT activation_mode FROM organization_production_controls
        WHERE organization_id = ${input.organizationId}::uuid
      `;
      expect(rows).toHaveLength(1);
      return snapshot();
    },
  });
}

function withSearchPath(urlString: string, schemaName: string): string {
  const url = new URL(urlString);
  url.searchParams.set("options", `-csearch_path=${schemaName}`);
  return url.toString();
}

async function waitForAdvisoryLockWait(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [state] = await admin!<{ waiting: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity
        WHERE application_name = 'task4-promotion-race'
          AND wait_event_type = 'Lock' AND wait_event = 'advisory'
      ) AS waiting
    `;
    if (state?.waiting === true) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("promotion did not wait for the operational health lock");
}

function promotionResponseCommitter(
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

function promotionResponse(result: PromotionResult): {
  readonly status: number;
  readonly body: unknown;
} {
  const status = {
    activationMode: result.status.activationMode,
    version: result.status.version,
    promotedAt: result.status.promotedAt,
    createdAt: result.status.createdAt,
    updatedAt: result.status.updatedAt,
  };
  return result.outcome === "blocked"
    ? {
        status: 409,
        body: {
          outcome: result.outcome,
          status,
          evaluation: result.evaluation,
        },
      }
    : { status: 200, body: { outcome: result.outcome, status } };
}
