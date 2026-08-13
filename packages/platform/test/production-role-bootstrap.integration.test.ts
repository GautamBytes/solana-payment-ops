import { randomUUID } from "node:crypto";
import { runMigrations as runIngestionMigrations } from "@payops/ingestion";
import { runMigrations as runReconciliationMigrations } from "@payops/reconciliation";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bootstrapProductionDatabaseRoles,
  OperationalHealthStore,
  OrganizationDatabase,
  ProductionControlStore,
  runPlatformMigrations,
  WorkerJobStore,
  type ProductionDatabasePrincipals,
  type ProductionDatabaseRoles,
} from "../src/index.js";

const baseDatabaseUrl = process.env.DATABASE_URL;
const describeDatabase = baseDatabaseUrl ? describe : describe.skip;
const suffix = `${process.pid}_${randomUUID().slice(0, 8)}`;
const schema = `payops_role_bootstrap_${suffix}`;
const password = `Role-${randomUUID()}-aA1!`;
const principalNames = {
  migrator: `payops_migrator_${suffix}`,
  runtime: `payops_runtime_${suffix}`,
  control: `payops_control_${suffix}`,
  readinessVerifier: `payops_verifier_${suffix}`,
  shadowProjector: `payops_projector_${suffix}`,
} satisfies ProductionDatabasePrincipals;
const rotatedNames = {
  migrator: `payops_migrator_rotated_${suffix}`,
  runtime: `payops_runtime_rotated_${suffix}`,
  control: `payops_control_rotated_${suffix}`,
  readinessVerifier: `payops_verifier_rotated_${suffix}`,
  shadowProjector: `payops_projector_rotated_${suffix}`,
} satisfies ProductionDatabasePrincipals;
const allPrincipalNames = [
  ...Object.values(principalNames),
  ...Object.values(rotatedNames),
];
const admin = baseDatabaseUrl
  ? postgres(baseDatabaseUrl, { max: 4, onnotice: () => undefined })
  : undefined;
let roles: ProductionDatabaseRoles | undefined;

describeDatabase("production database role bootstrap", () => {
  beforeAll(async () => {
    await admin!.unsafe(`CREATE SCHEMA ${schema}`);
    for (const role of allPrincipalNames) {
      await admin!.unsafe(
        `CREATE ROLE ${role} LOGIN PASSWORD '${password}' INHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`,
      );
    }
  });

  afterAll(async () => {
    await admin!.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    for (const role of allPrincipalNames) {
      await admin!.unsafe(`DROP ROLE IF EXISTS ${role}`);
    }
    if (roles !== undefined) {
      for (const role of Object.values(roles)) {
        await admin!.unsafe(`DROP ROLE IF EXISTS ${role}`);
      }
    }
    await admin?.end();
  });

  it("separates migration, runtime, control, verifier, and projector capabilities and rotates them", async () => {
    const adminUrl = withSearchPath(baseDatabaseUrl!, schema);
    await expect(
      bootstrapProductionDatabaseRoles(adminUrl, {
        ...principalNames,
        runtime: new URL(baseDatabaseUrl!).username,
      }),
    ).rejects.toMatchObject({
      code: "production_principal_must_be_restricted_login",
    });
    const bootstraps = await Promise.all([
      bootstrapProductionDatabaseRoles(adminUrl, principalNames),
      bootstrapProductionDatabaseRoles(adminUrl, principalNames),
    ]);
    expect(bootstraps[0]).toEqual(bootstraps[1]);
    roles = bootstraps[0];

    const migratorUrl = asRoleUrl(adminUrl, principalNames.migrator);
    await runIngestionMigrations(migratorUrl);
    await runReconciliationMigrations(migratorUrl);
    await runPlatformMigrations(migratorUrl);

    const attributes = await admin!<
      { rolname: string; rolsuper: boolean; rolbypassrls: boolean }[]
    >`
      SELECT rolname, rolsuper, rolbypassrls FROM pg_roles
      WHERE rolname = ANY(${allPrincipalNames}) ORDER BY rolname
    `;
    expect(attributes).toHaveLength(allPrincipalNames.length);
    expect(
      attributes.every((role) => !role.rolsuper && !role.rolbypassrls),
    ).toBe(true);

    const runtime = postgres(asRoleUrl(adminUrl, principalNames.runtime), {
      max: 1,
    });
    const migrator = postgres(migratorUrl, { max: 1 });
    const control = postgres(asRoleUrl(adminUrl, principalNames.control), {
      max: 1,
    });
    const verifier = postgres(
      asRoleUrl(adminUrl, principalNames.readinessVerifier),
      { max: 1 },
    );
    const projector = postgres(
      asRoleUrl(adminUrl, principalNames.shadowProjector),
      { max: 1 },
    );
    const organizationId = "00000000-0000-4000-8000-000000000001";
    const restrictedWorkerStore = new WorkerJobStore(
      asRoleUrl(adminUrl, principalNames.runtime),
    );
    try {
      await runtime`SELECT set_config('payops.organization_id', ${organizationId}, false)`;
      await control`SELECT set_config('payops.organization_id', ${organizationId}, false)`;
      await verifier`SELECT set_config('payops.organization_id', ${organizationId}, false)`;
      await projector`SELECT set_config('payops.organization_id', ${organizationId}, false)`;

      const restrictedInstance = await restrictedWorkerStore.startInstance({
        buildRevision: "restricted-role-test",
        rpc: {
          mode: "single_provider",
          cluster: "localnet",
          primaryProviderId: "restricted-provider",
          primaryEndpointEnvironment: "RESTRICTED_RPC",
          primaryEndpointDigest: "a".repeat(64),
          secondaryProviderId: null,
          secondaryEndpointEnvironment: null,
          secondaryEndpointDigest: null,
        },
      });
      const restrictedLease = await restrictedWorkerStore.claim({
        instanceId: restrictedInstance.id,
        name: "project_payment_status",
        now: new Date(),
        intervalMs: 2_000,
        leaseMs: 5_000,
      });
      expect(restrictedLease).not.toBeNull();
      await expect(
        restrictedWorkerStore.complete({
          lease: restrictedLease!,
          now: new Date(),
          cursor: { completed: true },
        }),
      ).resolves.toBe(true);
      await expect(verifier`
        SELECT count(*)::integer AS count
        FROM worker_instances, worker_job_states
      `).resolves.toHaveLength(1);

      await runtime`
        SELECT set_config('payops.production_control_operation', 'promote_live', false)
      `;

      await expect(runtime`
        SELECT * FROM payops_promote_production_control(
          ${organizationId}::uuid, 1, now(), 'runtime'
        )
      `).rejects.toMatchObject({ code: "42883" });
      await expect(runtime`
        UPDATE organization_production_controls SET activation_mode = 'live'
        WHERE organization_id = ${organizationId}::uuid
      `).rejects.toMatchObject({ code: "42501" });
      await expect(runtime`
        SELECT * FROM payops_request_production_promotion(
          ${organizationId}::uuid, 1, now(), 'runtime', 'system',
          ${randomUUID()}::uuid, NULL
        )
      `).rejects.toMatchObject({ code: "42501" });
      await expect(runtime`
        SELECT payops_attest_production_readiness(
          ${organizationId}::uuid, 1, true, true, true, true, now(), now() + interval '1 minute'
        )
      `).rejects.toMatchObject({ code: "42501" });
      await expect(runtime`
        SELECT payops_record_shadow_projection_decision(
          ${randomUUID()}::uuid, ${organizationId}::uuid, 1, 'forged',
          ${randomUUID()}::uuid, '1.0.0', 'exception', NULL, 'unchanged', NULL,
          'unknown_reference', '0.1', ${"a".repeat(64)}, now()
        )
      `).rejects.toMatchObject({ code: "42501" });

      const healthOrganizationId = randomUUID();
      await runtime.begin(async (transaction) => {
        await transaction`
          SELECT set_config('payops.organization_id', ${healthOrganizationId}, true)
        `;
        await transaction`
          INSERT INTO organization (id, name, slug, created_at)
          VALUES (
            ${healthOrganizationId}::uuid, 'Health boundary',
            ${`health-${suffix}`}, now()
          )
        `;
      });
      await runtime`
        SELECT set_config('payops.organization_id', ${healthOrganizationId}, false)
      `;
      await expect(runtime`
        INSERT INTO operational_incidents (
          id, organization_id, kind, severity, scope_key, state, version,
          first_observed_at, last_observed_at, occurrence_count,
          created_at, updated_at
        ) VALUES (
          ${randomUUID()}::uuid, ${healthOrganizationId}::uuid,
          'rpc_disagreement', 'critical', ${"a".repeat(64)}, 'open', 1,
          now(), now(), 1, now(), now()
        )
      `).rejects.toMatchObject({ code: "42501" });
      await expect(runtime`
        UPDATE operational_incidents SET occurrence_count = 999
      `).rejects.toMatchObject({ code: "42501" });
      await expect(runtime`
        DELETE FROM operational_incidents
      `).rejects.toMatchObject({ code: "42501" });
      await expect(runtime`
        INSERT INTO operational_incident_events (
          id, organization_id, incident_id, incident_version, action,
          to_state, occurrence_count, actor_kind, occurred_at, created_at
        ) VALUES (
          ${randomUUID()}::uuid, ${healthOrganizationId}::uuid,
          ${randomUUID()}::uuid, 1, 'opened', 'open', 1, 'system', now(), now()
        )
      `).rejects.toMatchObject({ code: "42501" });
      await expect(runtime`
        INSERT INTO operational_health_signals (
          organization_id, dedupe_key, measurement_kind, measurement_value,
          observed_at
        ) VALUES (
          ${healthOrganizationId}::uuid, ${"b".repeat(64)},
          'rpc_consensus_checks', 1, now()
        )
      `).rejects.toMatchObject({ code: "42501" });

      const healthDatabase = new OrganizationDatabase(
        asRoleUrl(adminUrl, principalNames.runtime),
      );
      try {
        const healthStore = new OperationalHealthStore(healthDatabase);
        const incident = await healthStore.observeIncident({
          organizationId: healthOrganizationId,
          actorId: "health-worker",
          actorKind: "system",
          kind: "rpc_disagreement",
          severity: "critical",
          scopeKey: "c".repeat(64),
          observedAt: new Date(),
        });
        await expect(
          healthStore.listIncidentHistory({
            organizationId: healthOrganizationId,
            actorId: "operator",
            incidentId: incident.id,
          }),
        ).resolves.toMatchObject({
          items: [{ action: "opened", incidentVersion: 1 }],
        });
        await expect(
          healthStore.listIncidentHistory({
            organizationId,
            actorId: "operator",
            incidentId: incident.id,
          }),
        ).rejects.toMatchObject({ code: "incident_not_found" });
      } finally {
        await healthDatabase.close();
      }
      await runtime`
        SELECT set_config('payops.organization_id', ${organizationId}, false)
      `;
      await expect(
        migrator.unsafe(`
        CREATE OR REPLACE FUNCTION payops_guard_production_control()
        RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$
      `),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        runtime.unsafe(`
        CREATE OR REPLACE FUNCTION payops_guard_shadow_projection_decision()
        RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$
      `),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        migrator.unsafe(`
        CREATE OR REPLACE FUNCTION payops_guard_reserved_audit_event()
        RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$
      `),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        migrator.unsafe(`
        CREATE OR REPLACE FUNCTION payops_immutable_audit_event()
        RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$
      `),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        migrator.unsafe(`
        CREATE OR REPLACE FUNCTION payops_finalize_production_control_authority()
        RETURNS void LANGUAGE sql AS $$ SELECT $$
      `),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(migrator`
        UPDATE organization_production_controls SET activation_mode = 'live'
        WHERE organization_id = ${organizationId}::uuid
      `).rejects.toMatchObject({ code: "42501" });
      await expect(migrator`
        UPDATE shadow_projection_decisions SET rule_code = rule_code
      `).rejects.toMatchObject({ code: "42501" });

      await expect(verifier`
        SELECT payops_attest_production_readiness(
          ${organizationId}::uuid, 1, true, true, true, true,
          transaction_timestamp() - interval '10 seconds',
          transaction_timestamp() + interval '30 seconds'
        )
      `).rejects.toMatchObject({ code: "22023" });

      for (const outcome of ["succeeded", "rejected"] as const) {
        for (const principal of [
          runtime,
          migrator,
          control,
          verifier,
          projector,
        ]) {
          await expect(principal`
            INSERT INTO audit_events (
              id, organization_id, actor_kind, actor_id, action, object_kind,
              object_id, request_id, outcome, reason_code, occurred_at
            ) VALUES (
              ${randomUUID()}::uuid, ${organizationId}::uuid, 'system',
              'forger', 'production_control.promote',
              'organization_production_control', ${organizationId},
              ${randomUUID()}::uuid, ${outcome}, 'forged', now()
            )
          `).rejects.toMatchObject({
            code: expect.stringMatching(/^(23514|42501)$/),
          });
        }
      }
      await expect(runtime`
        INSERT INTO audit_events (
          id, organization_id, actor_kind, actor_id, action, object_kind,
          object_id, request_id, outcome, reason_code, occurred_at
        ) VALUES (
          ${randomUUID()}::uuid, ${organizationId}::uuid, 'system', 'runtime',
          'wallet.create', 'wallet', ${randomUUID()}, ${randomUUID()}::uuid,
          'succeeded', 'created', now()
        )
      `).resolves.toEqual([]);
      await expect(migrator`
        ALTER TABLE audit_events
        DISABLE TRIGGER audit_events_reserved_production_control_guard
      `).rejects.toMatchObject({ code: "42501" });

      const owners = await admin!<{ owner_name: string }[]>`
        SELECT pg_get_userbyid(class.relowner) AS owner_name
        FROM pg_class AS class
        WHERE class.relnamespace = ${schema}::regnamespace
          AND class.relname = ANY(${[
            "organization_production_controls",
            "shadow_projection_decisions",
            "production_readiness_attestations",
            "audit_events",
            "operational_measurements",
            "operational_incidents",
            "operational_incident_events",
            "operational_health_signals",
          ]})
        UNION ALL
        SELECT pg_get_userbyid(procedure.proowner) AS owner_name
        FROM pg_proc AS procedure
        WHERE procedure.pronamespace = ${schema}::regnamespace
          AND procedure.proname = ANY(${[
            "payops_guard_production_control",
            "payops_guard_shadow_projection_decision",
            "payops_guard_production_readiness_attestation",
            "payops_guard_reserved_audit_event",
            "payops_immutable_audit_event",
            "payops_create_production_control_for_organization",
            "payops_lock_production_activation_mode",
            "payops_attest_production_readiness",
            "payops_request_production_promotion",
            "payops_record_shadow_projection_decision",
            "payops_guard_operational_health_record",
            "payops_record_operational_measurement",
            "payops_observe_operational_incident",
            "payops_acknowledge_operational_incident",
            "payops_resolve_operational_incident",
            "payops_operational_health_clear_for_promotion",
            "payops_process_operational_health_signals",
            "payops_enqueue_scheduled_operational_health_signals",
            "payops_enqueue_rpc_consensus_health_signal",
            "payops_enqueue_webhook_health_signal",
            "payops_enqueue_ledger_health_signal",
          ]})
      `;
      expect(owners).toHaveLength(29);
      expect(
        owners.every(({ owner_name }) => owner_name === roles!.authority),
      ).toBe(true);
      await expect(admin!`
        SELECT count(*)::integer AS count FROM pg_auth_members AS membership
        JOIN pg_roles AS role ON role.oid = membership.roleid
        WHERE role.rolname = ${roles!.authority}
      `).resolves.toEqual([{ count: 0 }]);

      const functionAcls = await admin!<
        { role_name: string; can_execute: boolean }[]
      >`
        SELECT role_name, has_function_privilege(
          role_name,
          ${`${schema}.payops_request_production_promotion(uuid,integer,timestamptz,text,text,uuid,uuid)`},
          'EXECUTE'
        ) AS can_execute
        FROM unnest(${[
          principalNames.runtime,
          principalNames.control,
          principalNames.readinessVerifier,
          principalNames.shadowProjector,
          principalNames.migrator,
        ]}::text[]) AS role_name
        ORDER BY role_name
      `;
      expect(
        functionAcls
          .filter(({ can_execute }) => can_execute)
          .map(({ role_name }) => role_name),
      ).toEqual([principalNames.control]);
      await expect(admin!`
        SELECT has_function_privilege(
          ${principalNames.runtime},
          ${`${schema}.payops_observe_operational_incident(uuid,text,text,text,text,timestamptz)`},
          'EXECUTE'
        ) AS workflow,
        has_table_privilege(
          ${principalNames.runtime}, ${`${schema}.operational_incidents`},
          'INSERT, UPDATE, DELETE'
        ) AS direct_dml
      `).resolves.toEqual([{ workflow: true, direct_dml: false }]);
      await expect(admin!`
        SELECT has_table_privilege(
          ${principalNames.readinessVerifier},
          ${`${schema}.organization_production_controls`}, 'SELECT'
        ) AS allowed
      `).resolves.toEqual([{ allowed: false }]);

      await expect(control`
        SELECT outcome, activation_mode, version
        FROM payops_request_production_promotion(
          ${organizationId}::uuid, 1, transaction_timestamp(), 'operator',
          'system', ${randomUUID()}::uuid, NULL
        )
      `).resolves.toEqual([
        { outcome: "blocked", activation_mode: "shadow", version: 1 },
      ]);
      await expect(projector`
        SELECT payops_record_shadow_projection_decision(
          ${randomUUID()}::uuid, ${organizationId}::uuid, 1, 'forged',
          ${randomUUID()}::uuid, '1.0.0', 'exception', NULL, 'unchanged', NULL,
          'unknown_reference', '0.1', ${"a".repeat(64)}, transaction_timestamp()
        )
      `).rejects.toMatchObject({ code: "23514" });

      const attestation = await verifier<{ id: string }[]>`
        SELECT payops_attest_production_readiness(
          ${organizationId}::uuid, 1, true, true, true, true,
          transaction_timestamp(), transaction_timestamp() + interval '1 minute'
        )::text AS id
      `;
      await expect(control`
        SELECT outcome, activation_mode, version
        FROM payops_request_production_promotion(
          ${organizationId}::uuid, 1, transaction_timestamp(), 'operator',
          'system', ${randomUUID()}::uuid, ${attestation[0]!.id}::uuid
        )
      `).resolves.toEqual([
        { outcome: "promoted", activation_mode: "live", version: 2 },
      ]);

      const storeOrganizationId = randomUUID();
      await runtime.begin(async (transaction) => {
        await transaction`
          SELECT set_config('payops.organization_id', ${storeOrganizationId}, true)
        `;
        await transaction`
          INSERT INTO organization (id, name, slug, created_at)
          VALUES (${storeOrganizationId}::uuid, 'Store boundary', ${`store-${suffix}`}, now())
        `;
      });
      const runtimeDatabase = new OrganizationDatabase(
        asRoleUrl(adminUrl, principalNames.runtime),
      );
      const controlDatabase = new OrganizationDatabase(
        asRoleUrl(adminUrl, principalNames.control),
      );
      const verifierDatabase = new OrganizationDatabase(
        asRoleUrl(adminUrl, principalNames.readinessVerifier),
        { max: 1 },
      );
      try {
        const store = new ProductionControlStore(
          runtimeDatabase,
          {
            evaluate: async () => ({
              completeWatchCoverage: true,
              freshWorkerHeartbeat: true,
              twoActiveProductionRpcRoles: true,
              noOpenCriticalIncident: true,
            }),
          },
          { controlDatabase, readinessVerifierDatabase: verifierDatabase },
        );
        await expect(
          store.promoteLive({
            organizationId: storeOrganizationId,
            actorKind: "system",
            actorId: "control-plane",
            auditRequestId: randomUUID(),
            expectedVersion: 1,
            now: new Date(),
          }),
        ).resolves.toMatchObject({
          outcome: "promoted",
          status: { version: 2 },
        });

        const staleOrganizationId = randomUUID();
        await runtime.begin(async (transaction) => {
          await transaction`
            SELECT set_config('payops.organization_id', ${staleOrganizationId}, true)
          `;
          await transaction`
            INSERT INTO organization (id, name, slug, created_at)
            VALUES (
              ${staleOrganizationId}::uuid, 'Stale evaluation',
              ${`stale-${suffix}`}, now()
            )
          `;
        });
        let markVerifierStarted!: () => void;
        const verifierStarted = new Promise<void>((resolve) => {
          markVerifierStarted = resolve;
        });
        const blocker = verifierDatabase.transaction(
          { organizationId: staleOrganizationId, actorId: "blocker" },
          async (sql) => {
            markVerifierStarted();
            await sql`SELECT pg_sleep(3)`;
          },
        );
        await verifierStarted;
        const staleStore = new ProductionControlStore(
          runtimeDatabase,
          {
            evaluate: async () => ({
              completeWatchCoverage: true,
              freshWorkerHeartbeat: true,
              twoActiveProductionRpcRoles: true,
              noOpenCriticalIncident: true,
            }),
          },
          { controlDatabase, readinessVerifierDatabase: verifierDatabase },
        );
        await expect(
          staleStore.promoteLive({
            organizationId: staleOrganizationId,
            actorKind: "system",
            actorId: "control-plane",
            auditRequestId: randomUUID(),
            expectedVersion: 1,
            now: new Date(),
          }),
        ).rejects.toMatchObject({ code: "22023" });
        await blocker;
      } finally {
        await Promise.all([
          runtimeDatabase.close(),
          controlDatabase.close(),
          verifierDatabase.close(),
        ]);
      }

      await expect(runtime`
        DELETE FROM worker_job_states
        WHERE name = 'reconcile_attempts'
      `).rejects.toMatchObject({ code: "42501" });
      await admin!.unsafe(
        `DELETE FROM ${schema}.worker_job_states WHERE name = 'reconcile_attempts'`,
      );
      await expect(runtime`
        INSERT INTO worker_job_states (name, interval_ms, lifecycle)
        VALUES ('reconcile_attempts', 2000, 'retired')
      `).rejects.toMatchObject({ code: "42501" });
      await expect(runtime`
        INSERT INTO worker_job_states (
          name, interval_ms, lifecycle, lease_token, lease_expires_at
        ) VALUES (
          'reconcile_attempts', 2000, 'retired', gen_random_uuid(),
          clock_timestamp() + interval '1 minute'
        )
      `).rejects.toMatchObject({ code: "42501" });

      await bootstrapProductionDatabaseRoles(adminUrl, rotatedNames);
      await expect(
        runtime.unsafe(
          `SELECT count(*) FROM ${schema}.organization_production_controls`,
        ),
      ).rejects.toMatchObject({ code: "42501" });
      const rotatedRuntime = postgres(
        asRoleUrl(adminUrl, rotatedNames.runtime),
        { max: 1 },
      );
      try {
        await rotatedRuntime`SELECT set_config('payops.organization_id', ${organizationId}, false)`;
        await expect(
          rotatedRuntime`SELECT activation_mode FROM organization_production_controls`,
        ).resolves.toEqual([{ activation_mode: "live" }]);
      } finally {
        await rotatedRuntime.end();
      }
    } finally {
      await Promise.all([
        restrictedWorkerStore.close(),
        runtime.end(),
        migrator.end(),
        control.end(),
        verifier.end(),
        projector.end(),
      ]);
    }
  }, 15_000);
});

function withSearchPath(urlString: string, schemaName: string): string {
  const url = new URL(urlString);
  url.searchParams.set("options", `-csearch_path=${schemaName}`);
  return url.toString();
}

function asRoleUrl(urlString: string, role: string): string {
  const url = new URL(urlString);
  url.username = role;
  url.password = password;
  return url.toString();
}
