import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { runMigrations as runIngestionMigrations } from "@payops/ingestion";
import { runMigrations as runReconciliationMigrations } from "@payops/reconciliation";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import {
  runMigrationSet,
  runPlatformMigrations,
  WorkerJobStore,
} from "../src/index.js";
import {
  cleanupTestProductionRoles,
  prepareTestProductionRoleBoundary,
} from "./production-role-test-helper.js";

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const admin = databaseUrl
  ? postgres(databaseUrl, { max: 1, onnotice: () => undefined })
  : undefined;
const schema = `payops_platform_migrations_${process.pid}`;
const schemaDatabaseUrl = databaseUrl
  ? withSearchPath(databaseUrl, schema)
  : undefined;
const scoped = schemaDatabaseUrl
  ? postgres(schemaDatabaseUrl, { max: 1, onnotice: () => undefined })
  : undefined;
const old4012Checksum =
  "5106489a0337e8f765ea2554662e97bc3985549431686c270951622a0eb293c1";

describeDatabase("coordinated migrations", () => {
  beforeAll(async () => {
    await admin!.unsafe(`CREATE SCHEMA ${schema}`);
  });

  beforeEach(async () => {
    await admin!.unsafe(`DROP SCHEMA ${schema} CASCADE`);
    await admin!.unsafe(`CREATE SCHEMA ${schema}`);
    await prepareTestProductionRoleBoundary(schemaDatabaseUrl!);
  });

  afterAll(async () => {
    await admin!.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await cleanupTestProductionRoles(schemaDatabaseUrl!);
    await scoped?.end();
    await admin?.end();
  });

  test("applies once and rejects changed bytes for an applied migration", async () => {
    await runMigrationSet(schemaDatabaseUrl!, [
      { name: "4001_test", sql: "CREATE TABLE migration_probe (id integer);" },
    ]);
    await runMigrationSet(schemaDatabaseUrl!, [
      { name: "4001_test", sql: "CREATE TABLE migration_probe (id integer);" },
    ]);

    const rows = await scoped!<{ count: string }[]>`
      SELECT count(*)::text AS count FROM payops_schema_migrations
      WHERE name = '4001_test'
    `;
    expect(rows[0]?.count).toBe("1");

    await expect(
      runMigrationSet(schemaDatabaseUrl!, [
        { name: "4001_test", sql: "CREATE TABLE migration_probe (id bigint);" },
      ]),
    ).rejects.toMatchObject({ code: "migration_checksum_mismatch" });
  });

  test("rolls back failed SQL without recording the migration", async () => {
    await expect(
      runMigrationSet(schemaDatabaseUrl!, [
        { name: "4001_broken", sql: "CREATE TABLE incomplete (" },
      ]),
    ).rejects.toBeDefined();

    const rows = await scoped!<{ count: string }[]>`
      SELECT count(*)::text AS count FROM payops_schema_migrations
      WHERE name = '4001_broken'
    `;
    expect(rows[0]?.count).toBe("0");
  });

  test("upgrades db57a518 4012 without checksum drift or a concurrent audit-trigger bypass", async () => {
    const boundary = await prepareTestProductionRoleBoundary(
      schemaDatabaseUrl!,
    );
    await runIngestionMigrations(schemaDatabaseUrl!);
    await runReconciliationMigrations(schemaDatabaseUrl!);
    const through4010 = [
      "4001_identity_organizations",
      "4002_tenant_scope_existing_data",
      "4003_merchants_customers_invoices",
      "4004_idempotency_and_audit",
      "4005_public_checkouts_and_rates",
      "4006_quotes_and_payment_attempts",
      "4007_hosted_reconciliation_and_projections",
      "4008_worker_jobs",
      "4009_payment_attempt_idempotency",
      "4010_merchant_operations",
    ];
    await runMigrationSet(
      schemaDatabaseUrl!,
      await readPlatformMigrations(through4010),
    );
    const organizationId = "00000000-0000-4000-8000-000000000003";
    const auditId = randomUUID();
    await scoped!`
      INSERT INTO organization (id, name, slug, created_at)
      VALUES (
        ${organizationId}::uuid, 'Existing at old 4012',
        'existing-at-old-4012', now()
      )
    `;
    await scoped!`
      INSERT INTO audit_events (
        id, organization_id, actor_kind, actor_id, action, object_kind,
        object_id, request_id, outcome, reason_code, occurred_at
      ) VALUES (
        ${auditId}::uuid, ${organizationId}::uuid, 'system', 'upgrade-test',
        'wallet.create', 'wallet', 'pre-existing', ${randomUUID()}::uuid,
        'succeeded', 'created', now()
      )
    `;
    await runMigrationSet(
      schemaDatabaseUrl!,
      await readPlatformMigrations(["4011_production_controls"]),
    );

    const [old4012] = await readPlatformMigrations([
      "4012_production_control_authority",
    ]);
    expect(
      createHash("sha256").update(old4012!.sql, "utf8").digest("hex"),
    ).toBe(old4012Checksum);
    await runMigrationSet(schemaDatabaseUrl!, [old4012!]);

    await scoped!.unsafe(`
      DROP FUNCTION payops_production_role_bootstrap_marker();
      CREATE OR REPLACE FUNCTION payops_finalize_production_control_authority()
      RETURNS void LANGUAGE plpgsql SECURITY DEFINER
      SET search_path = pg_catalog, ${schema}, pg_temp
      AS $$ BEGIN RAISE EXCEPTION 'old bootstrap finalizer'; END $$
    `);
    await scoped!.begin(async (transaction) => {
      await transaction.unsafe(
        `ALTER TABLE audit_events OWNER TO ${quoteIdentifier(boundary.principals.migrator)}`,
      );
      await transaction.unsafe(
        `SET LOCAL ROLE ${quoteIdentifier(boundary.principals.migrator)}`,
      );
      await transaction.unsafe(`
        CREATE FUNCTION payops_production_role_bootstrap_marker()
        RETURNS text LANGUAGE sql IMMUTABLE
        SET search_path = pg_catalog, pg_temp
        AS $$ SELECT '4013'::text $$
      `);
      await transaction.unsafe(`
        CREATE FUNCTION payops_rewrite_audit_action_for_test()
        RETURNS trigger LANGUAGE plpgsql
        SET search_path = pg_catalog, pg_temp
        AS $$ BEGIN
          NEW.action := 'production_control.promote';
          RETURN NEW;
        END $$
      `);
      await transaction.unsafe(`
        CREATE TRIGGER zz_payops_rewrite_audit_action_for_test
        BEFORE INSERT ON audit_events
        FOR EACH ROW EXECUTE FUNCTION payops_rewrite_audit_action_for_test()
      `);
    });
    await expect(scoped!`
      SELECT pg_get_userbyid(procedure.proowner) AS owner_name
      FROM pg_proc AS procedure
      WHERE procedure.oid =
        'payops_production_role_bootstrap_marker()'::regprocedure
    `).resolves.toEqual([{ owner_name: boundary.principals.migrator }]);
    await expect(
      runPlatformMigrations(schemaDatabaseUrl!),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(scoped!`
      SELECT count(*)::integer AS count
      FROM payops_schema_migrations
      WHERE name = '4013_production_control_review_hardening'
    `).resolves.toEqual([{ count: 0 }]);

    await prepareTestProductionRoleBoundary(schemaDatabaseUrl!);
    await expect(scoped!`
      SELECT pg_get_userbyid(procedure.proowner) =
          pg_get_userbyid(namespace.nspowner) AS owner_authenticated,
        payops_production_role_bootstrap_marker() AS bootstrap_version
      FROM pg_proc AS procedure
      JOIN pg_namespace AS namespace
        ON namespace.oid = procedure.pronamespace
      WHERE procedure.oid =
        'payops_production_role_bootstrap_marker()'::regprocedure
    `).resolves.toEqual([
      { owner_authenticated: true, bootstrap_version: "4013" },
    ]);
    await expect(
      runPlatformMigrations(schemaDatabaseUrl!),
    ).rejects.toMatchObject({
      code: "55000",
      message: expect.stringContaining(
        "unexpected or invalid audit_events trigger",
      ),
    });
    await expect(scoped!`
      SELECT count(*)::integer AS count
      FROM payops_schema_migrations
      WHERE name = '4013_production_control_review_hardening'
    `).resolves.toEqual([{ count: 0 }]);

    await scoped!.unsafe(`
      DROP TRIGGER zz_payops_rewrite_audit_action_for_test ON audit_events;
      DROP FUNCTION payops_rewrite_audit_action_for_test();
    `);
    await prepareTestProductionRoleBoundary(schemaDatabaseUrl!);
    const raceFunction = `payops_race_audit_action_${process.pid}`;
    const raceEventTrigger = `payops_race_audit_ddl_${process.pid}`;
    const raceEventFunction = `payops_race_audit_ddl_function_${process.pid}`;
    const raceApplicationName = `payops-race-audit-ddl-${process.pid}`;
    const raceLockKey = 4_013_000 + (process.pid % 100_000);
    const attacker = postgres(schemaDatabaseUrl!, {
      max: 1,
      onnotice: () => undefined,
    });
    const barrier = postgres(databaseUrl!, {
      max: 1,
      onnotice: () => undefined,
    });
    await attacker.begin(async (transaction) => {
      await transaction.unsafe(
        `SET LOCAL ROLE ${quoteIdentifier(boundary.principals.migrator)}`,
      );
      await transaction.unsafe(`
        CREATE FUNCTION ${quoteIdentifier(raceFunction)}()
        RETURNS trigger LANGUAGE plpgsql
        SET search_path = pg_catalog, pg_temp
        AS $$ BEGIN
          NEW.action := 'production_control.promote';
          RETURN NEW;
        END $$
      `);
    });
    await admin!.unsafe(
      `DROP EVENT TRIGGER IF EXISTS ${quoteIdentifier(raceEventTrigger)}`,
    );
    await admin!.unsafe(
      `DROP FUNCTION IF EXISTS public.${quoteIdentifier(raceEventFunction)}()`,
    );
    await admin!.unsafe(`
      CREATE FUNCTION public.${quoteIdentifier(raceEventFunction)}()
      RETURNS event_trigger LANGUAGE plpgsql
      AS $$ BEGIN
        IF current_setting('application_name') = ${quoteLiteral(raceApplicationName)}
          AND TG_TAG = 'DROP TRIGGER'
        THEN
          PERFORM pg_advisory_lock(${raceLockKey});
          PERFORM pg_advisory_unlock(${raceLockKey});
        END IF;
      END $$
    `);
    await admin!.unsafe(`
      CREATE EVENT TRIGGER ${quoteIdentifier(raceEventTrigger)}
      ON ddl_command_start WHEN TAG IN ('DROP TRIGGER')
      EXECUTE FUNCTION public.${quoteIdentifier(raceEventFunction)}()
    `);

    let migrationOutcome:
      { readonly ok: true } | { readonly ok: false; readonly error: unknown };
    let attackerOutcome:
      { readonly ok: true } | { readonly ok: false; readonly error: unknown };
    let attackerBlocked = false;
    try {
      await barrier`SELECT pg_advisory_lock(${raceLockKey})`;
      const migration = runPlatformMigrations(
        withApplicationName(schemaDatabaseUrl!, raceApplicationName),
      ).then(
        () => ({ ok: true }) as const,
        (error: unknown) => ({ ok: false, error }) as const,
      );
      await waitForDatabaseCondition(async () => {
        const [lock] = await admin!<{ waiting: boolean }[]>`
          SELECT EXISTS (
            SELECT 1 FROM pg_locks
            WHERE locktype = 'advisory' AND NOT granted
              AND objid = ${raceLockKey}
          ) AS waiting
        `;
        return lock?.waiting === true;
      });
      await expect(scoped!`
        SELECT count(*)::integer AS count
        FROM payops_schema_migrations
        WHERE name = '4013_production_control_review_hardening'
      `).resolves.toEqual([{ count: 0 }]);

      const attack = attacker
        .begin(async (transaction) => {
          await transaction.unsafe(
            `SET LOCAL ROLE ${quoteIdentifier(boundary.principals.migrator)}`,
          );
          await transaction.unsafe(`
            CREATE TRIGGER zz_payops_race_audit_action
            BEFORE INSERT ON audit_events
            FOR EACH ROW EXECUTE FUNCTION ${quoteIdentifier(raceFunction)}()
          `);
        })
        .then(
          () => ({ ok: true }) as const,
          (error: unknown) => ({ ok: false, error }) as const,
        );
      attackerBlocked = await waitForDatabaseCondition(async () => {
        const [lock] = await admin!<{ waiting: boolean }[]>`
          SELECT EXISTS (
            SELECT 1 FROM pg_locks
            WHERE relation = ${`${schema}.audit_events`}::regclass
              AND NOT granted
          ) AS waiting
        `;
        return lock?.waiting === true;
      }).then(
        () => true,
        () => false,
      );
      await barrier`SELECT pg_advisory_unlock(${raceLockKey})`;
      [migrationOutcome, attackerOutcome] = await Promise.all([
        migration,
        attack,
      ]);
    } finally {
      await barrier`SELECT pg_advisory_unlock(${raceLockKey})`;
      await admin!.unsafe(
        `DROP EVENT TRIGGER IF EXISTS ${quoteIdentifier(raceEventTrigger)}`,
      );
      await admin!.unsafe(
        `DROP FUNCTION IF EXISTS public.${quoteIdentifier(raceEventFunction)}()`,
      );
      await Promise.all([attacker.end(), barrier.end()]);
    }
    expect(attackerBlocked).toBe(true);
    expect(migrationOutcome!).toEqual({ ok: true });
    expect(attackerOutcome!).toMatchObject({
      ok: false,
      error: { code: "42501" },
    });
    await scoped!.unsafe(`DROP FUNCTION ${quoteIdentifier(raceFunction)}()`);
    await runPlatformMigrations(schemaDatabaseUrl!);

    await expect(scoped!`
      SELECT migration.name, migration.checksum_sha256
      FROM payops_schema_migrations AS migration
      WHERE migration.name IN (
        '4012_production_control_authority',
        '4013_production_control_review_hardening'
      )
      ORDER BY migration.name
    `).resolves.toEqual([
      {
        name: "4012_production_control_authority",
        checksum_sha256: old4012Checksum,
      },
      {
        name: "4013_production_control_review_hardening",
        checksum_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    ]);
    const preserved = await scoped!.begin(async (transaction) => {
      await transaction`
        SELECT set_config('payops.organization_id', ${organizationId}, true)
      `;
      return transaction`
        SELECT organization.name, controls.activation_mode, controls.version,
          audit.action
        FROM organization
        JOIN organization_production_controls AS controls
          ON controls.organization_id = organization.id
        JOIN audit_events AS audit ON audit.organization_id = organization.id
        WHERE organization.id = ${organizationId}::uuid
          AND audit.id = ${auditId}::uuid
      `;
    });
    expect(preserved).toEqual([
      {
        name: "Existing at old 4012",
        activation_mode: "shadow",
        version: 1,
        action: "wallet.create",
      },
    ]);
    await expect(scoped!`
      SELECT
        pg_get_functiondef(
          'payops_attest_production_readiness(uuid,integer,boolean,boolean,boolean,boolean,timestamptz,timestamptz)'::regprocedure
        ) LIKE '%clock_timestamp() - interval ''2 seconds''%' AS bounded,
        to_regprocedure('payops_guard_reserved_audit_event()') IS NOT NULL AS guarded
    `).resolves.toEqual([{ bounded: true, guarded: true }]);
    await expect(scoped!`
      SELECT trigger.tgname AS trigger_name
      FROM pg_trigger AS trigger
      WHERE trigger.tgrelid = 'audit_events'::regclass
        AND NOT trigger.tgisinternal
      ORDER BY trigger.tgname
    `).resolves.toEqual([
      { trigger_name: "audit_events_immutable" },
      { trigger_name: "audit_events_reserved_production_control_guard" },
    ]);

    await expect(
      scoped!.begin(async (transaction) => {
        await transaction.unsafe(
          `SET LOCAL ROLE ${quoteIdentifier(boundary.principals.runtime)}`,
        );
        await transaction`
          SELECT set_config('payops.organization_id', ${organizationId}, true)
        `;
        await transaction`
          INSERT INTO audit_events (
            id, organization_id, actor_kind, actor_id, action, object_kind,
            object_id, request_id, outcome, reason_code, occurred_at
          ) VALUES (
            ${randomUUID()}::uuid, ${organizationId}::uuid, 'system', 'forger',
            'production_control.promote', 'organization_production_control',
            ${organizationId}, ${randomUUID()}::uuid, 'succeeded', 'forged', now()
          )
        `;
      }),
    ).rejects.toMatchObject({ code: "23514" });
  }, 15_000);

  test("upgrades PR 7 through the exact checkout migration sequence without creating capabilities", async () => {
    await runIngestionMigrations(schemaDatabaseUrl!);
    await runReconciliationMigrations(schemaDatabaseUrl!);
    await runPlatformMigrations(schemaDatabaseUrl!);
    await runPlatformMigrations(schemaDatabaseUrl!);

    const migrations = await scoped!<{ name: string }[]>`
      SELECT name FROM payops_schema_migrations
      WHERE name LIKE '40%'
      ORDER BY name
    `;
    expect(migrations.map(({ name }) => name)).toEqual([
      "4001_identity_organizations",
      "4002_tenant_scope_existing_data",
      "4003_merchants_customers_invoices",
      "4004_idempotency_and_audit",
      "4005_public_checkouts_and_rates",
      "4006_quotes_and_payment_attempts",
      "4007_hosted_reconciliation_and_projections",
      "4008_worker_jobs",
      "4009_payment_attempt_idempotency",
      "4010_merchant_operations",
      "4011_production_controls",
      "4012_production_control_authority",
      "4013_production_control_review_hardening",
      "4014_worker_readiness",
      "4015_operational_health",
    ]);
    const attemptColumns = await scoped!<{ name: string; nullable: string }[]>`
      SELECT column_name AS name, is_nullable AS nullable
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'payment_attempts'
        AND column_name IN ('idempotency_key', 'payment_url')
      ORDER BY column_name
    `;
    expect(attemptColumns).toEqual([
      { name: "idempotency_key", nullable: "YES" },
      { name: "payment_url", nullable: "YES" },
    ]);
    const pairingConstraint = await scoped!<{ definition: string }[]>`
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid = 'payment_attempts'::regclass
        AND conname = 'payment_attempts_idempotency_pair'
    `;
    expect(pairingConstraint).toEqual([
      {
        definition:
          "CHECK (((idempotency_key IS NULL) = (payment_url IS NULL)))",
      },
    ]);
    await expect(
      scoped!<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM public_checkouts
      `,
    ).resolves.toEqual([{ count: 0 }]);

    const jobs = await scoped!<{ name: string }[]>`
      SELECT name FROM worker_job_states ORDER BY name
    `;
    expect(jobs.map(({ name }) => name)).toEqual([
      "expire_quotes",
      "ingest_watch_targets",
      "project_payment_status",
      "reconcile_attempts",
      "refresh_finality",
      "send_webhooks",
      "verify_rpc_consensus",
    ]);

    const tenantTables = await scoped!<
      { name: string; rowSecurity: boolean; forced: boolean }[]
    >`
      SELECT relname AS name, relrowsecurity AS "rowSecurity",
        relforcerowsecurity AS forced
      FROM pg_class
      WHERE relnamespace = current_schema()::regnamespace
        AND relname = ANY(${[
          "public_checkouts",
          "quote_rate_observations",
          "payment_attempts",
          "payment_quotes",
          "hosted_payment_expectations",
          "payment_projections",
          "payment_status_history",
          "hosted_payment_allocations",
          "exception_case_events",
          "ledger_accounts",
          "journal_entries",
          "journal_lines",
          "ledger_reconciliations",
          "evidence_packs",
          "accounting_exports",
          "organization_production_controls",
          "shadow_projection_decisions",
        ]})
      ORDER BY relname
    `;
    expect(tenantTables).toHaveLength(17);
    expect(
      tenantTables.every(({ rowSecurity, forced }) => rowSecurity && forced),
    ).toBe(true);
  });

  test("upgrades an existing organization from 4010 with a durable shadow control exactly once", async () => {
    await runIngestionMigrations(schemaDatabaseUrl!);
    await runReconciliationMigrations(schemaDatabaseUrl!);
    const through4010 = [
      "4001_identity_organizations",
      "4002_tenant_scope_existing_data",
      "4003_merchants_customers_invoices",
      "4004_idempotency_and_audit",
      "4005_public_checkouts_and_rates",
      "4006_quotes_and_payment_attempts",
      "4007_hosted_reconciliation_and_projections",
      "4008_worker_jobs",
      "4009_payment_attempt_idempotency",
      "4010_merchant_operations",
    ];
    await runMigrationSet(
      schemaDatabaseUrl!,
      await readPlatformMigrations(through4010),
    );
    const existingOrganizationId = "00000000-0000-4000-8000-000000000002";
    await scoped!`
      INSERT INTO organization (id, name, slug, created_at)
      VALUES (
        ${existingOrganizationId}::uuid, 'Existing before 4011',
        'existing-before-4011', now()
      )
    `;

    const migration4011 = await readPlatformMigrations([
      "4011_production_controls",
    ]);
    await runMigrationSet(schemaDatabaseUrl!, migration4011);
    await runMigrationSet(schemaDatabaseUrl!, migration4011);

    const controls = await scoped!<
      {
        organization_id: string;
        activation_mode: string;
        version: number;
        promoted_at: Date | null;
        promoted_by: string | null;
      }[]
    >`
      SELECT organization_id::text, activation_mode, version,
        promoted_at, promoted_by
      FROM organization_production_controls
      WHERE organization_id = ${existingOrganizationId}::uuid
    `;
    expect(controls).toEqual([
      {
        organization_id: existingOrganizationId,
        activation_mode: "shadow",
        version: 1,
        promoted_at: null,
        promoted_by: null,
      },
    ]);
    const applied = await scoped!<{ count: number }[]>`
      SELECT count(*)::integer AS count
      FROM payops_schema_migrations
      WHERE name = '4011_production_controls'
    `;
    expect(applied).toEqual([{ count: 1 }]);

    const migration4012 = await readPlatformMigrations([
      "4012_production_control_authority",
    ]);
    await runMigrationSet(schemaDatabaseUrl!, migration4012);
    await runMigrationSet(schemaDatabaseUrl!, migration4012);
    const migration4013 = await readPlatformMigrations([
      "4013_production_control_review_hardening",
    ]);
    await runMigrationSet(schemaDatabaseUrl!, migration4013);
    await runMigrationSet(schemaDatabaseUrl!, migration4013);

    const owners = await scoped!<
      { object_name: string; owner_name: string; runtime_name: string }[]
    >`
      SELECT class.relname AS object_name,
        pg_get_userbyid(class.relowner) AS owner_name,
        current_user AS runtime_name
      FROM pg_class AS class
      WHERE class.relnamespace = current_schema()::regnamespace
        AND class.relname IN (
          'organization_production_controls', 'shadow_projection_decisions',
          'production_readiness_attestations', 'audit_events'
        )
      UNION ALL
      SELECT procedure.proname AS object_name,
        pg_get_userbyid(procedure.proowner) AS owner_name,
        current_user AS runtime_name
      FROM pg_proc AS procedure
      WHERE procedure.pronamespace = current_schema()::regnamespace
        AND procedure.proname IN (
          'payops_ensure_production_control',
          'payops_promote_production_control',
          'payops_record_shadow_projection_decision',
          'payops_guard_production_control',
          'payops_guard_shadow_projection_decision',
          'payops_guard_production_readiness_attestation',
          'payops_guard_reserved_audit_event',
          'payops_immutable_audit_event',
          'payops_create_production_control_for_organization',
          'payops_lock_production_activation_mode',
          'payops_attest_production_readiness',
          'payops_request_production_promotion'
        )
      ORDER BY object_name
    `;
    expect(owners).toHaveLength(14);
    const authorityName = owners[0]!.owner_name;
    expect(
      owners.every(
        ({ owner_name, runtime_name }) =>
          owner_name === authorityName && owner_name !== runtime_name,
      ),
    ).toBe(true);
    const authorityMemberships = await scoped!<{ count: number }[]>`
      SELECT count(*)::integer AS count
      FROM pg_auth_members AS membership
      JOIN pg_roles AS role ON role.oid = membership.roleid
      WHERE role.rolname = ${authorityName}
    `;
    expect(authorityMemberships).toEqual([{ count: 0 }]);
    await scoped!`
      SELECT set_config(
        'payops.organization_id', ${existingOrganizationId}, false
      )
    `;
    await expect(
      scoped!`
        UPDATE organization_production_controls
        SET activation_mode = 'live', version = 2,
          promoted_at = now(), promoted_by = 'runtime', updated_at = now()
        WHERE organization_id = ${existingOrganizationId}::uuid
      `,
    ).rejects.toMatchObject({ code: "23514" });
    const hardeningApplied = await scoped!<{ count: number }[]>`
      SELECT count(*)::integer AS count
      FROM payops_schema_migrations
      WHERE name IN (
        '4012_production_control_authority',
        '4013_production_control_review_hardening'
      )
    `;
    expect(hardeningApplied).toEqual([{ count: 2 }]);
  });

  test("upgrades worker readiness from 4013 idempotently with closed SQL constraints", async () => {
    await runIngestionMigrations(schemaDatabaseUrl!);
    await runReconciliationMigrations(schemaDatabaseUrl!);
    const through4013 = [
      "4001_identity_organizations",
      "4002_tenant_scope_existing_data",
      "4003_merchants_customers_invoices",
      "4004_idempotency_and_audit",
      "4005_public_checkouts_and_rates",
      "4006_quotes_and_payment_attempts",
      "4007_hosted_reconciliation_and_projections",
      "4008_worker_jobs",
      "4009_payment_attempt_idempotency",
      "4010_merchant_operations",
      "4011_production_controls",
      "4012_production_control_authority",
      "4013_production_control_review_hardening",
    ];
    await runMigrationSet(
      schemaDatabaseUrl!,
      await readPlatformMigrations(through4013),
    );
    const migration4012 = await readPlatformMigrations([
      "4014_worker_readiness",
    ]);
    await runMigrationSet(schemaDatabaseUrl!, migration4012);
    await runMigrationSet(schemaDatabaseUrl!, migration4012);

    const applied = await scoped!<{ count: number }[]>`
      SELECT count(*)::integer AS count FROM payops_schema_migrations
      WHERE name = '4014_worker_readiness'
    `;
    expect(applied).toEqual([{ count: 1 }]);
    await expect(
      scoped!`
        INSERT INTO worker_instances (
          id, state, build_revision, started_at, last_heartbeat_at
        ) VALUES (
          gen_random_uuid(), 'healthy', 'test', now(), now()
        )
      `,
    ).rejects.toThrow();
    await expect(
      scoped!`
        UPDATE worker_job_states SET last_failure_class = 'raw_rpc_error'
        WHERE name = 'verify_rpc_consensus'
      `,
    ).rejects.toThrow();
    await expect(
      scoped!`
        INSERT INTO worker_job_states (name, interval_ms)
        VALUES ('arbitrary_label', 1000)
      `,
    ).rejects.toThrow();

    const columns = await scoped!<{ name: string }[]>`
      SELECT column_name AS name FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name IN ('worker_instances', 'worker_job_states')
        AND column_name IN (
          'labels', 'error_code', 'error_message', 'signature', 'url', 'payload'
        )
    `;
    expect(columns).toEqual([]);
    await expect(scoped!<{ name: string }[]>`
      SELECT column_name AS name FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'worker_instances'
        AND column_name IN (
          'primary_endpoint_env', 'primary_endpoint_digest',
          'secondary_endpoint_env', 'secondary_endpoint_digest'
        )
      ORDER BY column_name
    `).resolves.toEqual([
      { name: "primary_endpoint_digest" },
      { name: "primary_endpoint_env" },
      { name: "secondary_endpoint_digest" },
      { name: "secondary_endpoint_env" },
    ]);
  });

  test("upgrades operational health after 4014 idempotently with forced tenant scope", async () => {
    const boundary = await prepareTestProductionRoleBoundary(
      schemaDatabaseUrl!,
    );
    await runIngestionMigrations(schemaDatabaseUrl!);
    await runReconciliationMigrations(schemaDatabaseUrl!);
    await runMigrationSet(
      schemaDatabaseUrl!,
      await readPlatformMigrations([
        "4001_identity_organizations",
        "4002_tenant_scope_existing_data",
        "4003_merchants_customers_invoices",
        "4004_idempotency_and_audit",
        "4005_public_checkouts_and_rates",
        "4006_quotes_and_payment_attempts",
        "4007_hosted_reconciliation_and_projections",
        "4008_worker_jobs",
        "4009_payment_attempt_idempotency",
        "4010_merchant_operations",
        "4011_production_controls",
        "4012_production_control_authority",
        "4013_production_control_review_hardening",
        "4014_worker_readiness",
      ]),
    );
    await expect(scoped!`
      SELECT
        finalizer.prosecdef AS security_definer,
        finalizer.proowner = namespace.nspowner AS owner_matches_schema,
        controls.relowner = attestations.relowner AS protected_owner_matches,
        controls.relowner <> namespace.nspowner AS protected_owner_is_separate
      FROM pg_proc AS finalizer
      JOIN pg_namespace AS namespace
        ON namespace.oid = finalizer.pronamespace
      CROSS JOIN pg_class AS controls
      CROSS JOIN pg_class AS attestations
      WHERE finalizer.oid =
        'payops_finalize_production_control_authority()'::regprocedure
        AND controls.oid = 'organization_production_controls'::regclass
        AND attestations.oid = 'production_readiness_attestations'::regclass
    `).resolves.toEqual([
      {
        security_definer: true,
        owner_matches_schema: true,
        protected_owner_matches: true,
        protected_owner_is_separate: true,
      },
    ]);
    const organizationId = "00000000-0000-4000-8000-000000000001";
    const walletId = randomUUID();
    await scoped!`SELECT set_config('payops.organization_id', ${organizationId}, false)`;
    await scoped!`
      INSERT INTO rpc_providers (
        id, cluster, endpoint_env, endpoint_label, active, created_at
      ) VALUES
        ('legacy-health-primary', 'mainnet-beta', 'LEGACY_PRIMARY', 'legacy', true, now()),
        ('legacy-health-secondary', 'mainnet-beta', 'LEGACY_SECONDARY', 'legacy-2', true, now())
    `;
    await scoped!`
      INSERT INTO rpc_consensus_checks (
        organization_id, cluster, signature, generation,
        primary_provider_id, secondary_provider_id, state,
        claim_token, claimed_until, started_at, completed_at
      ) VALUES (
        ${organizationId}::uuid, 'mainnet-beta', ${"a".repeat(64)}, 1,
        'legacy-health-primary', 'legacy-health-secondary', 'disagreed',
        gen_random_uuid(), now(), now() - interval '1 minute', now()
      )
    `;
    await scoped!`
      INSERT INTO merchant_wallets (
        id, organization_id, address, cluster, status, verified_at, created_at
      ) VALUES (
        ${walletId}::uuid, ${organizationId}::uuid, ${"b".repeat(32)},
        'mainnet-beta', 'active', now(), now()
      )
    `;
    await scoped!`
      INSERT INTO ledger_reconciliations (
        id, organization_id, wallet_id, mint, comparison_slot,
        observed_base_units, ledger_base_units, difference_base_units,
        coverage_state, balance_state, reason_code, reconciled_at
      ) VALUES (
        gen_random_uuid(), ${organizationId}::uuid, ${walletId}::uuid,
        ${"c".repeat(32)}, 1, 2, 1, 1, 'complete', 'mismatch',
        'legacy_check', now()
      )
    `;
    const healthMigration = await readPlatformMigrations([
      "4015_operational_health",
    ]);
    await runMigrationSet(schemaDatabaseUrl!, healthMigration);
    await runMigrationSet(schemaDatabaseUrl!, healthMigration);

    await expect(scoped!`
      SELECT count(*)::integer AS count FROM payops_schema_migrations
      WHERE name = '4015_operational_health'
    `).resolves.toEqual([{ count: 1 }]);
    await expect(scoped!<{ name: string; forced: boolean }[]>`
      SELECT class.relname AS name, class.relforcerowsecurity AS forced
      FROM pg_class AS class
      WHERE class.relnamespace = current_schema()::regnamespace
        AND class.relname = ANY(${[
          "operational_measurements",
          "operational_incidents",
          "operational_incident_events",
          "operational_health_signals",
        ]})
      ORDER BY class.relname
    `).resolves.toEqual([
      { name: "operational_health_signals", forced: true },
      { name: "operational_incident_events", forced: true },
      { name: "operational_incidents", forced: true },
      { name: "operational_measurements", forced: true },
    ]);
    await expect(scoped!`
      SELECT kind, count(*)::integer AS count
      FROM operational_incidents
      WHERE organization_id = ${organizationId}::uuid
      GROUP BY kind ORDER BY kind
    `).resolves.toEqual([
      { kind: "ledger_mismatch", count: 1 },
      { kind: "rpc_disagreement", count: 1 },
    ]);

    await scoped!.unsafe(
      "ALTER TABLE operational_health_signals DISABLE TRIGGER operational_health_signals_privileged_workflow",
    );
    try {
      await expect(
        scoped!`
          INSERT INTO operational_health_signals (
            organization_id, dedupe_key, incident_kind, observed_at
          ) VALUES (
            ${organizationId}::uuid, ${"d".repeat(64)},
            'worker_stale', now()
          )
        `,
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await scoped!.unsafe(
        "ALTER TABLE operational_health_signals ENABLE TRIGGER operational_health_signals_privileged_workflow",
      );
    }
  });

  test("blocks a legacy promotion across the operational health authority upgrade", async () => {
    const boundary = await prepareTestProductionRoleBoundary(
      schemaDatabaseUrl!,
    );
    await runIngestionMigrations(schemaDatabaseUrl!);
    await runReconciliationMigrations(schemaDatabaseUrl!);
    await runMigrationSet(
      schemaDatabaseUrl!,
      await readPlatformMigrations([
        "4001_identity_organizations",
        "4002_tenant_scope_existing_data",
        "4003_merchants_customers_invoices",
        "4004_idempotency_and_audit",
        "4005_public_checkouts_and_rates",
        "4006_quotes_and_payment_attempts",
        "4007_hosted_reconciliation_and_projections",
        "4008_worker_jobs",
        "4009_payment_attempt_idempotency",
        "4010_merchant_operations",
        "4011_production_controls",
        "4012_production_control_authority",
        "4013_production_control_review_hardening",
        "4014_worker_readiness",
      ]),
    );
    const organizationId = "00000000-0000-4000-8000-000000000001";
    await scoped!`SELECT set_config('payops.organization_id', ${organizationId}, false)`;
    await scoped!`
      INSERT INTO rpc_providers (
        id, cluster, endpoint_env, endpoint_label, active, created_at
      ) VALUES
        ('upgrade-race-primary', 'mainnet-beta', 'UPGRADE_RACE_PRIMARY',
          'upgrade race primary', true, now()),
        ('upgrade-race-secondary', 'mainnet-beta', 'UPGRADE_RACE_SECONDARY',
          'upgrade race secondary', true, now())
    `;
    await scoped!`
      INSERT INTO rpc_consensus_checks (
        organization_id, cluster, signature, generation,
        primary_provider_id, secondary_provider_id, state,
        claim_token, claimed_until, started_at, completed_at
      ) VALUES (
        ${organizationId}::uuid, 'mainnet-beta', ${"f".repeat(64)}, 1,
        'upgrade-race-primary', 'upgrade-race-secondary', 'disagreed',
        gen_random_uuid(), clock_timestamp(),
        clock_timestamp() - interval '1 minute', clock_timestamp()
      )
    `;
    const [attestation] = await scoped!.begin(async (transaction) => {
      await transaction.unsafe(
        `SET LOCAL ROLE ${quoteIdentifier(boundary.principals.readinessVerifier)}`,
      );
      await transaction`
        SELECT set_config('payops.organization_id', ${organizationId}, true)
      `;
      return transaction<{ id: string }[]>`
        SELECT payops_attest_production_readiness(
          ${organizationId}::uuid, 1, true, true, true, true,
          transaction_timestamp(), transaction_timestamp() + interval '4 minutes'
        )::text AS id
      `;
    });

    const migrationApplicationName = `payops-health-upgrade-${process.pid}`;
    const promotionApplicationName = `payops-legacy-promotion-${process.pid}`;
    const eventTrigger = `payops_pause_health_upgrade_${process.pid}`;
    const eventFunction = `payops_pause_health_upgrade_function_${process.pid}`;
    const migrationLockKey = 4_015_000 + (process.pid % 100_000);
    const migrationBarrier = postgres(databaseUrl!, {
      max: 1,
      onnotice: () => undefined,
    });
    const promotionClient = postgres(
      withApplicationName(schemaDatabaseUrl!, promotionApplicationName),
      { max: 1, onnotice: () => undefined },
    );
    await admin!.unsafe(
      `DROP EVENT TRIGGER IF EXISTS ${quoteIdentifier(eventTrigger)}`,
    );
    await admin!.unsafe(
      `DROP FUNCTION IF EXISTS public.${quoteIdentifier(eventFunction)}()`,
    );
    await admin!.unsafe(`
      CREATE FUNCTION public.${quoteIdentifier(eventFunction)}()
      RETURNS event_trigger LANGUAGE plpgsql
      AS $$ BEGIN
        IF current_setting('application_name') = ${quoteLiteral(migrationApplicationName)}
          AND TG_TAG = 'ALTER FUNCTION'
        THEN
          PERFORM pg_advisory_lock(${migrationLockKey});
          PERFORM pg_advisory_unlock(${migrationLockKey});
        END IF;
      END $$
    `);
    await admin!.unsafe(`
      CREATE EVENT TRIGGER ${quoteIdentifier(eventTrigger)}
      ON ddl_command_start WHEN TAG IN ('ALTER FUNCTION')
      EXECUTE FUNCTION public.${quoteIdentifier(eventFunction)}()
    `);

    let promotionSettled = false;
    let promotionBlocked = false;
    try {
      await migrationBarrier`SELECT pg_advisory_lock(${migrationLockKey})`;
      const migration = runMigrationSet(
        withApplicationName(schemaDatabaseUrl!, migrationApplicationName),
        await readPlatformMigrations(["4015_operational_health"]),
      ).then(
        () => ({ ok: true }) as const,
        (error: unknown) => ({ ok: false, error }) as const,
      );
      await waitForDatabaseCondition(async () => {
        const [lock] = await admin!<{ waiting: boolean }[]>`
          SELECT EXISTS (
            SELECT 1 FROM pg_locks
            WHERE locktype = 'advisory' AND NOT granted
              AND objid = ${migrationLockKey}
          ) AS waiting
        `;
        return lock?.waiting === true;
      });

      const promotion = promotionClient
        .begin(async (transaction) => {
          await transaction.unsafe(
            `SET LOCAL ROLE ${quoteIdentifier(boundary.principals.control)}`,
          );
          await transaction`
            SELECT set_config('payops.organization_id', ${organizationId}, true)
          `;
          const [result] = await transaction<{ outcome: string }[]>`
            SELECT outcome
            FROM payops_request_production_promotion(
              ${organizationId}::uuid, 1, clock_timestamp(), 'operator',
              'system', ${randomUUID()}::uuid, ${attestation!.id}::uuid
            )
          `;
          return result!;
        })
        .then(
          (result) => ({ ok: true, result }) as const,
          (error: unknown) => ({ ok: false, error }) as const,
        )
        .finally(() => {
          promotionSettled = true;
        });

      await waitForDatabaseCondition(async () => {
        if (promotionSettled) return true;
        const [lock] = await admin!<{ waiting: boolean }[]>`
          SELECT EXISTS (
            SELECT 1
            FROM pg_stat_activity AS activity
            JOIN pg_locks AS lock ON lock.pid = activity.pid
            WHERE activity.application_name = ${promotionApplicationName}
              AND lock.relation = ${`${schema}.organization_production_controls`}::regclass
              AND NOT lock.granted
          ) AS waiting
        `;
        promotionBlocked = lock?.waiting === true;
        return promotionBlocked;
      });
      await migrationBarrier`SELECT pg_advisory_unlock(${migrationLockKey})`;
      const [migrationOutcome, promotionOutcome] = await Promise.all([
        migration,
        promotion,
      ]);

      expect(migrationOutcome).toEqual({ ok: true });
      expect(promotionBlocked).toBe(true);
      expect(promotionOutcome).toMatchObject({
        ok: false,
        error: { code: "23514" },
      });
      await expect(scoped!`
        SELECT activation_mode, version
        FROM organization_production_controls
        WHERE organization_id = ${organizationId}::uuid
      `).resolves.toEqual([{ activation_mode: "shadow", version: 1 }]);
      await expect(scoped!`
        SELECT kind, state FROM operational_incidents
        WHERE organization_id = ${organizationId}::uuid
          AND kind = 'rpc_disagreement'
      `).resolves.toEqual([{ kind: "rpc_disagreement", state: "open" }]);
    } finally {
      await migrationBarrier`SELECT pg_advisory_unlock(${migrationLockKey})`;
      await admin!.unsafe(
        `DROP EVENT TRIGGER IF EXISTS ${quoteIdentifier(eventTrigger)}`,
      );
      await admin!.unsafe(
        `DROP FUNCTION IF EXISTS public.${quoteIdentifier(eventFunction)}()`,
      );
      await Promise.all([migrationBarrier.end(), promotionClient.end()]);
    }
  }, 15_000);

  test("preserves an active legacy lease and permits old-style completion during 4014 rollout", async () => {
    await runIngestionMigrations(schemaDatabaseUrl!);
    await runReconciliationMigrations(schemaDatabaseUrl!);
    await runMigrationSet(
      schemaDatabaseUrl!,
      await readPlatformMigrations([
        "4001_identity_organizations",
        "4002_tenant_scope_existing_data",
        "4003_merchants_customers_invoices",
        "4004_idempotency_and_audit",
        "4005_public_checkouts_and_rates",
        "4006_quotes_and_payment_attempts",
        "4007_hosted_reconciliation_and_projections",
        "4008_worker_jobs",
        "4009_payment_attempt_idempotency",
        "4010_merchant_operations",
        "4011_production_controls",
        "4012_production_control_authority",
        "4013_production_control_review_hardening",
      ]),
    );
    const legacyLeaseToken = "00000000-0000-4000-8000-000000000088";
    await scoped!`
      UPDATE worker_job_states
      SET lease_token = ${legacyLeaseToken}::uuid,
        lease_expires_at = clock_timestamp() + interval '1 minute',
        last_started_at = clock_timestamp(), last_error_code = NULL,
        updated_at = clock_timestamp()
      WHERE name = 'project_payment_status'
    `;

    await runMigrationSet(
      schemaDatabaseUrl!,
      await readPlatformMigrations(["4014_worker_readiness"]),
    );
    await expect(
      scoped!<
        {
          lease_token: string | null;
          lease_owner_id: string | null;
          has_legacy_error: boolean;
        }[]
      >`
        SELECT state.lease_token::text, state.lease_owner_id::text,
          EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'worker_job_states'
              AND column_name = 'last_error_code'
          ) AS has_legacy_error
        FROM worker_job_states AS state
        WHERE state.name = 'project_payment_status'
      `,
    ).resolves.toEqual([
      {
        lease_token: legacyLeaseToken,
        lease_owner_id: null,
        has_legacy_error: true,
      },
    ]);

    const store = new WorkerJobStore(schemaDatabaseUrl!);
    try {
      const instance = await store.startInstance({
        buildRevision: "new-worker",
        rpc: {
          mode: "single_provider",
          cluster: "localnet",
          primaryProviderId: "legacy-test-provider",
          primaryEndpointEnvironment: "LEGACY_TEST_RPC",
          primaryEndpointDigest: "a".repeat(64),
          secondaryProviderId: null,
          secondaryEndpointEnvironment: null,
          secondaryEndpointDigest: null,
        },
      });
      await expect(
        store.claim({
          instanceId: instance.id,
          name: "project_payment_status",
          now: new Date("2999-01-01T00:00:00.000Z"),
          intervalMs: 2_000,
          leaseMs: 5_000,
        }),
      ).resolves.toBeNull();
    } finally {
      await store.close();
    }

    await expect(
      scoped!`
        UPDATE worker_job_states
        SET lease_token = NULL, lease_expires_at = NULL,
          cursor = '{"legacyCompleted":true}'::jsonb,
          last_completed_at = clock_timestamp(), last_error_code = NULL,
          version = version + 1, updated_at = clock_timestamp()
        WHERE name = 'project_payment_status'
          AND lease_token = ${legacyLeaseToken}::uuid
      `,
    ).resolves.toHaveLength(0);
    await expect(
      scoped!<{ cursor: Record<string, boolean> }[]>`
        SELECT cursor FROM worker_job_states
        WHERE name = 'project_payment_status'
      `,
    ).resolves.toEqual([{ cursor: { legacyCompleted: true } }]);

    const nextLegacyToken = "00000000-0000-4000-8000-000000000089";
    await expect(
      scoped!<{ name: string }[]>`
        UPDATE worker_job_states
        SET lease_token = ${nextLegacyToken}::uuid,
          lease_expires_at = clock_timestamp() + interval '1 minute',
          last_started_at = clock_timestamp(), last_error_code = NULL,
          version = version + 1, updated_at = clock_timestamp()
        WHERE name = 'send_webhooks' AND lease_token IS NULL
        RETURNING name
      `,
    ).resolves.toEqual([{ name: "send_webhooks" }]);
  });

  test("retires reconcile_attempts without preserving or reacquiring any legacy lease", async () => {
    await runIngestionMigrations(schemaDatabaseUrl!);
    await runReconciliationMigrations(schemaDatabaseUrl!);
    await runMigrationSet(
      schemaDatabaseUrl!,
      await readPlatformMigrations([
        "4001_identity_organizations",
        "4002_tenant_scope_existing_data",
        "4003_merchants_customers_invoices",
        "4004_idempotency_and_audit",
        "4005_public_checkouts_and_rates",
        "4006_quotes_and_payment_attempts",
        "4007_hosted_reconciliation_and_projections",
        "4008_worker_jobs",
        "4009_payment_attempt_idempotency",
        "4010_merchant_operations",
        "4011_production_controls",
        "4012_production_control_authority",
        "4013_production_control_review_hardening",
      ]),
    );
    await scoped!`
      UPDATE worker_job_states
      SET lease_token = gen_random_uuid(),
        lease_expires_at = clock_timestamp() + interval '1 minute',
        last_started_at = clock_timestamp(), updated_at = clock_timestamp()
      WHERE name = 'reconcile_attempts'
    `;

    await runMigrationSet(
      schemaDatabaseUrl!,
      await readPlatformMigrations(["4014_worker_readiness"]),
    );

    await expect(scoped!`
      SELECT lifecycle, lease_token::text, lease_expires_at
      FROM worker_job_states WHERE name = 'reconcile_attempts'
    `).resolves.toEqual([
      { lifecycle: "retired", lease_token: null, lease_expires_at: null },
    ]);
    await expect(scoped!`
      UPDATE worker_job_states
      SET lease_token = gen_random_uuid(),
        lease_expires_at = clock_timestamp() + interval '1 minute'
      WHERE name = 'reconcile_attempts'
    `).rejects.toMatchObject({ code: "23514" });
    await expect(scoped!`
      UPDATE worker_job_states
      SET lease_token = gen_random_uuid(),
        lease_expires_at = clock_timestamp() + interval '1 minute'
      WHERE name = 'reconcile_attempts'
        AND lease_token IS NOT NULL
    `).resolves.toHaveLength(0);
    await expect(scoped!`
      UPDATE worker_job_states SET lifecycle = 'active'
      WHERE name = 'reconcile_attempts'
    `).rejects.toMatchObject({ code: "23514" });
    await expect(scoped!`
      DELETE FROM worker_job_states
      WHERE name = 'reconcile_attempts'
    `).resolves.toHaveLength(0);
    await expect(scoped!`
      INSERT INTO worker_job_states (
        name, interval_ms, lifecycle, lease_token, lease_expires_at
      ) VALUES (
        'reconcile_attempts', 2000, 'retired', gen_random_uuid(),
        clock_timestamp() + interval '1 minute'
      )
    `).rejects.toMatchObject({ code: "23514" });
  });

  test("preserves legacy closed exceptions with explicit unknown provenance", async () => {
    await runIngestionMigrations(schemaDatabaseUrl!);
    await runReconciliationMigrations(schemaDatabaseUrl!);
    const priorNames = [
      "4001_identity_organizations",
      "4002_tenant_scope_existing_data",
      "4003_merchants_customers_invoices",
      "4004_idempotency_and_audit",
      "4005_public_checkouts_and_rates",
      "4006_quotes_and_payment_attempts",
      "4007_hosted_reconciliation_and_projections",
      "4008_worker_jobs",
      "4009_payment_attempt_idempotency",
    ];
    await runMigrationSet(
      schemaDatabaseUrl!,
      await Promise.all(
        priorNames.map(async (name) => ({
          name,
          sql: await readFile(
            new URL(`../migrations/${name}.sql`, import.meta.url),
            "utf8",
          ),
        })),
      ),
    );
    await seedLegacyResolvedException();
    await runMigrationSet(schemaDatabaseUrl!, [
      {
        name: "4010_merchant_operations",
        sql: await readFile(
          new URL(
            "../migrations/4010_merchant_operations.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      },
    ]);

    const rows = await scoped!<
      {
        resolution_code: string;
        resolution_note: string;
        resolved_by: string;
        resolved_at: Date;
      }[]
    >`
      SELECT resolution_code, resolution_note, resolved_by, resolved_at
      FROM hosted_payment_exceptions
    `;
    expect(rows).toEqual([
      {
        resolution_code: "legacy_resolution_unknown",
        resolution_note:
          "Migrated from a pre-audit exception state; original resolution metadata is unavailable.",
        resolved_by: "system:migration-4010",
        resolved_at: new Date("2026-08-01T00:00:00.000Z"),
      },
    ]);
  });
});

async function readPlatformMigrations(
  names: readonly string[],
): Promise<{ name: string; sql: string }[]> {
  return Promise.all(
    names.map(async (name) => ({
      name,
      sql: await readFile(
        new URL(`../migrations/${name}.sql`, import.meta.url),
        "utf8",
      ),
    })),
  );
}

async function seedLegacyResolvedException(): Promise<void> {
  const organizationId = "00000000-0000-4000-8000-000000000001";
  const customerId = "00000000-0000-4000-8000-000000000101";
  const walletId = "00000000-0000-4000-8000-000000000102";
  const invoiceId = "00000000-0000-4000-8000-000000000103";
  const checkoutId = "00000000-0000-4000-8000-000000000104";
  const attemptId = "00000000-0000-4000-8000-000000000105";
  const exceptionId = "00000000-0000-4000-8000-000000000106";
  await scoped!`SELECT set_config('payops.organization_id', ${organizationId}, false)`;
  await scoped!`
    INSERT INTO customers (id, organization_id, display_name, metadata)
    VALUES (${customerId}::uuid, ${organizationId}::uuid, 'Legacy buyer', '{}')
  `;
  await scoped!`
    INSERT INTO merchant_wallets (
      id, organization_id, address, cluster, status, verified_at
    ) VALUES (
      ${walletId}::uuid, ${organizationId}::uuid,
      '11111111111111111111111111111111', 'mainnet-beta', 'active', now()
    )
  `;
  await scoped!`
    INSERT INTO merchant_invoices (
      id, organization_id, public_reference, customer_id,
      settlement_wallet_id, accepted_asset_symbols, currency, status,
      subtotal_minor_units, tax_minor_units, total_minor_units, due_at
    ) VALUES (
      ${invoiceId}::uuid, ${organizationId}::uuid, 'INV-LEGACY',
      ${customerId}::uuid, ${walletId}::uuid, ARRAY['USDC']::text[],
      'USD', 'issued', 100, 0, 100, now()
    )
  `;
  await scoped!`
    INSERT INTO public_checkouts (
      id, organization_id, invoice_id, public_nonce, derivation_key_id, state
    ) VALUES (
      ${checkoutId}::uuid, ${organizationId}::uuid, ${invoiceId}::uuid,
      ${Buffer.alloc(32, 1)}, 'legacy', 'active'
    )
  `;
  await scoped!`
    INSERT INTO payment_attempts (
      id, public_attempt_id, organization_id, invoice_id, checkout_id,
      asset_symbol, reference_address, recipient_address, mint,
      recipient_token_account, state
    ) VALUES (
      ${attemptId}::uuid, '00000000-0000-4000-8000-000000000107'::uuid,
      ${organizationId}::uuid, ${invoiceId}::uuid, ${checkoutId}::uuid,
      'USDC', ${"2".repeat(32)}, ${"3".repeat(32)}, ${"4".repeat(32)},
      ${"5".repeat(32)}, 'exception'
    )
  `;
  await scoped!`
    INSERT INTO rpc_providers (
      id, cluster, endpoint_env, endpoint_label, active, created_at
    ) VALUES ('legacy-provider', 'mainnet-beta', 'LEGACY_RPC', 'legacy', true, now())
  `;
  const raw = await scoped!<{ id: string }[]>`
    INSERT INTO raw_transactions (
      provider_id, signature, commitment, digest, canonical_body, body,
      byte_length, retrieved_at
    ) VALUES (
      'legacy-provider', ${"6".repeat(64)}, 'finalized', ${"a".repeat(64)},
      '{}', '{}'::jsonb, 2, now()
    ) RETURNING id::text
  `;
  const event = await scoped!<{ id: string }[]>`
    INSERT INTO chain_events (
      event_id, cluster, signature, outer_instruction_index,
      inner_instruction_index, raw_transaction_id, current_state
    ) VALUES (
      'legacy-event', 'mainnet-beta', ${"6".repeat(64)}, 0, -1,
      ${raw[0]!.id}::bigint, 'finalized'
    ) RETURNING id::text
  `;
  await scoped!`
    INSERT INTO normalized_transfers (
      chain_event_id, parser_version, program_id, source_token_account,
      source_account_index, mint, destination_token_account,
      destination_account_index, authority, amount_base_units, decimals
    ) VALUES (
      ${event[0]!.id}::bigint, '1.0.0', ${"7".repeat(32)}, ${"8".repeat(32)},
      0, ${"4".repeat(32)}, ${"5".repeat(32)}, 1, ${"9".repeat(32)}, 100, 6
    )
  `;
  await scoped!`
    INSERT INTO hosted_payment_exceptions (
      id, organization_id, invoice_id, attempt_id, chain_event_id,
      parser_version, event_id, signature, outer_instruction_index,
      inner_instruction_index, amount_base_units, rule_code, rule_version,
      review_state, created_at
    ) VALUES (
      ${exceptionId}::uuid, ${organizationId}::uuid, ${invoiceId}::uuid,
      ${attemptId}::uuid, ${event[0]!.id}::bigint, '1.0.0', 'legacy-event',
      ${"6".repeat(64)}, 0, NULL, 100, 'wrong_amount', '1.0.0', 'resolved',
      '2026-08-01T00:00:00.000Z'
    )
  `;
}

function withSearchPath(urlString: string, schemaName: string): string {
  const url = new URL(urlString);
  url.searchParams.set("options", `-csearch_path=${schemaName}`);
  return url.toString();
}

function withApplicationName(
  urlString: string,
  applicationName: string,
): string {
  const url = new URL(urlString);
  url.searchParams.set("application_name", applicationName);
  return url.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function waitForDatabaseCondition(
  check: () => Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for database condition");
}
