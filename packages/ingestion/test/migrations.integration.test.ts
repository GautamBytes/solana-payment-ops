import { readFile } from "node:fs/promises";
import postgres, { type Sql } from "postgres";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { runMigrations } from "../src/index.js";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://payops:payops@127.0.0.1:55432/payops_test";
const schema = `payops_ingestion_migrations_${process.pid}`;
const organizationIds = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000099",
] as const;
const schemaDatabaseUrl = withSearchPath(
  databaseUrl,
  schema,
  organizationIds[0],
);
const admin = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
const forgerRole = `payops_migration_forger_${process.pid}`;
let scoped: Sql;

beforeAll(async () => {
  await admin.unsafe(`DROP ROLE IF EXISTS ${forgerRole}`);
  await admin.unsafe(`CREATE ROLE ${forgerRole} NOLOGIN`);
});

beforeEach(async () => {
  await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.unsafe(`CREATE SCHEMA ${schema}`);
  scoped = postgres(schemaDatabaseUrl, { max: 1, onnotice: () => undefined });
});

afterEach(async () => {
  await scoped.end();
});

afterAll(async () => {
  await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.unsafe(`DROP ROLE IF EXISTS ${forgerRole}`);
  await admin.end();
});

describe("ingestion migration lineage", () => {
  it("creates fresh schemas with ordered independent evidence columns", async () => {
    const releasedMigration = await readFile(
      new URL("../migrations/0004_rpc_consensus.sql", import.meta.url),
      "utf8",
    );
    expect(releasedMigration).not.toContain("safe_error_retryable");

    await runMigrations(schemaDatabaseUrl);

    const migrations = await scoped<{ name: string }[]>`
      SELECT name FROM payops_schema_migrations ORDER BY name
    `;
    const columns = await scoped<
      { column_name: string; is_nullable: string }[]
    >`
      SELECT column_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'rpc_consensus_provider_observations'
        AND column_name IN (
          'safe_error_retryable', 'status_slot',
          'status_execution_digest', 'transaction_execution_digest'
        )
      ORDER BY column_name
    `;

    expect(migrations.map(({ name }) => name)).toEqual([
      "0001_durable_ingestion",
      "0002_finality_claim_token",
      "0003_pending_representation",
      "0004_rpc_consensus",
      "0005_rpc_consensus_error_retryability",
      "0006_rpc_consensus_internal_evidence",
    ]);
    expect(columns).toEqual([
      { column_name: "safe_error_retryable", is_nullable: "YES" },
      { column_name: "status_execution_digest", is_nullable: "YES" },
      { column_name: "status_slot", is_nullable: "YES" },
      { column_name: "transaction_execution_digest", is_nullable: "YES" },
    ]);
  });

  it("upgrades an already-ledgered 0004 schema and backfills every tenant", async () => {
    await runMigrations(schemaDatabaseUrl);
    await seedErrorObservations(scoped);
    await restoreLedgered0004Shape(scoped);

    await runMigrations(schemaDatabaseUrl);

    const rows = await observationsWithoutTenantRls(scoped);
    expect(rows).toEqual([
      { organization_id: organizationIds[0], safe_error_retryable: true },
      { organization_id: organizationIds[1], safe_error_retryable: true },
    ]);
  });

  it("backfills legacy complete rows and rejects new incomplete component evidence", async () => {
    await runMigrations(schemaDatabaseUrl);
    await restoreLedgered0005Shape(scoped);
    const checkId = await seedLegacyCompleteObservation(scoped);

    await runMigrations(schemaDatabaseUrl);

    const [legacy] = await scoped<
      {
        status_slot: string;
        status_execution_digest: string;
        transaction_execution_digest: string;
      }[]
    >`
      SELECT status_slot::text, status_execution_digest,
        transaction_execution_digest
      FROM rpc_consensus_provider_observations
      WHERE provider_id = 'primary'
    `;
    expect(legacy).toEqual({
      status_slot: "42",
      status_execution_digest: "e".repeat(64),
      transaction_execution_digest: "e".repeat(64),
    });

    await expect(
      scoped`
        INSERT INTO rpc_consensus_provider_observations (
          organization_id, consensus_check_id, generation, provider_id,
          canonical_digest, snapshot_digest, parsing_digest,
          transfer_identity_digest, slot, execution_state, execution_digest,
          finality, response_time_ms, safe_error_code, safe_error_retryable,
          observed_at, created_at
        ) VALUES (
          ${organizationIds[0]}::uuid, ${checkId}::bigint, 1, 'secondary',
          ${"a".repeat(64)}, ${"b".repeat(64)}, ${"c".repeat(64)},
          ${"d".repeat(64)}, 42, 'succeeded', ${"e".repeat(64)},
          'finalized/finalized', 5, NULL, NULL,
          clock_timestamp(), clock_timestamp()
        )
      `,
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("reapplies a data-bearing migration without weakening runtime RLS", async () => {
    await runMigrations(schemaDatabaseUrl);
    await seedErrorObservations(scoped);
    await scoped.unsafe(`
      ALTER TABLE rpc_consensus_provider_observations
        NO FORCE ROW LEVEL SECURITY;
      DROP TRIGGER rpc_consensus_provider_observations_guard
        ON rpc_consensus_provider_observations;
      DO $$
      DECLARE
        constraint_name name;
      BEGIN
        FOR constraint_name IN
          SELECT conname FROM pg_constraint
          WHERE conrelid = 'rpc_consensus_provider_observations'::regclass
            AND pg_get_constraintdef(oid) LIKE '%safe_error_retryable%'
        LOOP
          EXECUTE format(
            'ALTER TABLE rpc_consensus_provider_observations DROP CONSTRAINT %I',
            constraint_name
          );
        END LOOP;
      END
      $$;
      UPDATE rpc_consensus_provider_observations
      SET safe_error_retryable = NULL;
      ALTER TABLE rpc_consensus_provider_observations
        FORCE ROW LEVEL SECURITY;
      CREATE TRIGGER rpc_consensus_provider_observations_guard
      BEFORE INSERT OR UPDATE OR DELETE
        ON rpc_consensus_provider_observations
      FOR EACH ROW EXECUTE FUNCTION payops_guard_rpc_consensus_observation();
      DELETE FROM payops_schema_migrations
      WHERE name = '0005_rpc_consensus_error_retryability';
    `);

    await runMigrations(schemaDatabaseUrl);

    expect(await observationsWithoutTenantRls(scoped)).toEqual([
      { organization_id: organizationIds[0], safe_error_retryable: true },
      { organization_id: organizationIds[1], safe_error_retryable: true },
    ]);
    const [security] = await scoped<
      { relrowsecurity: boolean; relforcerowsecurity: boolean }[]
    >`
      SELECT relrowsecurity, relforcerowsecurity
      FROM pg_class
      WHERE oid = 'rpc_consensus_provider_observations'::regclass
    `;
    expect(security).toEqual({
      relrowsecurity: true,
      relforcerowsecurity: true,
    });

    await scoped.unsafe(`GRANT USAGE ON SCHEMA ${schema} TO ${forgerRole}`);
    await scoped.unsafe(
      `GRANT SELECT, UPDATE ON rpc_consensus_provider_observations TO ${forgerRole}`,
    );
    await expect(
      scoped.begin(async (sql) => {
        await sql.unsafe(`SET LOCAL ROLE ${forgerRole}`);
        await sql`
          SELECT set_config('payops.organization_id', ${organizationIds[0]}, true)
        `;
        await sql`
          UPDATE rpc_consensus_provider_observations
          SET safe_error_retryable = false
        `;
      }),
    ).rejects.toMatchObject({ code: "23514" });
  });
});

async function seedErrorObservations(sql: Sql): Promise<void> {
  await sql`
    INSERT INTO rpc_providers (id, cluster, endpoint_env, endpoint_label)
    VALUES
      ('primary', 'mainnet-beta', 'PRIMARY_RPC_URL', 'primary'),
      ('secondary', 'mainnet-beta', 'SECONDARY_RPC_URL', 'secondary')
  `;
  for (const [index, organizationId] of organizationIds.entries()) {
    await sql.begin(async (transaction) => {
      await transaction`
        SELECT set_config('payops.organization_id', ${organizationId}, true)
      `;
      const [check] = await transaction<{ id: string }[]>`
        INSERT INTO rpc_consensus_checks (
          organization_id, cluster, signature, generation,
          primary_provider_id, secondary_provider_id, state, claim_token,
          claimed_until, started_at
        ) VALUES (
          ${organizationId}::uuid, 'mainnet-beta', ${String(index + 1).repeat(64)},
          1, 'primary', 'secondary', 'pending',
          ${
            index === 0
              ? "00000000-0000-4000-8000-000000000011"
              : "00000000-0000-4000-8000-000000000012"
          }::uuid,
          clock_timestamp() + interval '1 minute', clock_timestamp()
        )
        RETURNING id::text
      `;
      if (check === undefined) throw new Error("Expected consensus check");
      await transaction`
        INSERT INTO rpc_consensus_provider_observations (
          organization_id, consensus_check_id, generation, provider_id,
          response_time_ms, safe_error_code, safe_error_retryable,
          observed_at, created_at
        ) VALUES (
          ${organizationId}::uuid, ${check.id}::bigint, 1, 'primary', 5,
          'rpc_rate_limited', true, clock_timestamp(), clock_timestamp()
        )
      `;
    });
  }
}

async function restoreLedgered0004Shape(sql: Sql): Promise<void> {
  await sql.unsafe(`
    ALTER TABLE rpc_consensus_provider_observations
      NO FORCE ROW LEVEL SECURITY;
    DROP TRIGGER rpc_consensus_provider_observations_guard
      ON rpc_consensus_provider_observations;
    ALTER TABLE rpc_consensus_provider_observations
      DROP COLUMN safe_error_retryable CASCADE,
      DROP COLUMN IF EXISTS status_slot CASCADE,
      DROP COLUMN IF EXISTS status_execution_digest CASCADE,
      DROP COLUMN IF EXISTS transaction_execution_digest CASCADE;
    ALTER TABLE rpc_consensus_provider_observations
      FORCE ROW LEVEL SECURITY;
    CREATE TRIGGER rpc_consensus_provider_observations_guard
    BEFORE INSERT OR UPDATE OR DELETE
      ON rpc_consensus_provider_observations
    FOR EACH ROW EXECUTE FUNCTION payops_guard_rpc_consensus_observation();
    DELETE FROM payops_schema_migrations
    WHERE name IN (
      '0005_rpc_consensus_error_retryability',
      '0006_rpc_consensus_internal_evidence'
    );
  `);
}

async function restoreLedgered0005Shape(sql: Sql): Promise<void> {
  await sql.unsafe(`
    ALTER TABLE rpc_consensus_provider_observations
      NO FORCE ROW LEVEL SECURITY;
    DROP TRIGGER rpc_consensus_provider_observations_guard
      ON rpc_consensus_provider_observations;
    ALTER TABLE rpc_consensus_provider_observations
      DROP COLUMN IF EXISTS status_slot CASCADE,
      DROP COLUMN IF EXISTS status_execution_digest CASCADE,
      DROP COLUMN IF EXISTS transaction_execution_digest CASCADE;
    ALTER TABLE rpc_consensus_provider_observations
      FORCE ROW LEVEL SECURITY;
    CREATE TRIGGER rpc_consensus_provider_observations_guard
    BEFORE INSERT OR UPDATE OR DELETE
      ON rpc_consensus_provider_observations
    FOR EACH ROW EXECUTE FUNCTION payops_guard_rpc_consensus_observation();
    DELETE FROM payops_schema_migrations
    WHERE name = '0006_rpc_consensus_internal_evidence';
  `);
}

async function seedLegacyCompleteObservation(sql: Sql): Promise<string> {
  await sql`
    INSERT INTO rpc_providers (id, cluster, endpoint_env, endpoint_label)
    VALUES
      ('primary', 'mainnet-beta', 'PRIMARY_RPC_URL', 'primary'),
      ('secondary', 'mainnet-beta', 'SECONDARY_RPC_URL', 'secondary')
  `;
  const [check] = await sql<{ id: string }[]>`
    INSERT INTO rpc_consensus_checks (
      organization_id, cluster, signature, generation,
      primary_provider_id, secondary_provider_id, state, claim_token,
      claimed_until, started_at, completed_at
    ) VALUES (
      ${organizationIds[0]}::uuid, 'mainnet-beta', ${"1".repeat(64)}, 1,
      'primary', 'secondary', 'agreed',
      '00000000-0000-4000-8000-000000000021'::uuid,
      clock_timestamp() + interval '1 minute', clock_timestamp(),
      clock_timestamp()
    )
    RETURNING id::text
  `;
  if (check === undefined) throw new Error("Expected legacy consensus check");
  await sql`
    INSERT INTO rpc_consensus_provider_observations (
      organization_id, consensus_check_id, generation, provider_id,
      canonical_digest, snapshot_digest, parsing_digest,
      transfer_identity_digest, slot, execution_state, execution_digest,
      finality, response_time_ms, safe_error_code, safe_error_retryable,
      observed_at, created_at
    ) VALUES (
      ${organizationIds[0]}::uuid, ${check.id}::bigint, 1, 'primary',
      ${"a".repeat(64)}, ${"b".repeat(64)}, ${"c".repeat(64)},
      ${"d".repeat(64)}, 42, 'succeeded', ${"e".repeat(64)},
      'finalized/finalized', 5, NULL, NULL,
      clock_timestamp(), clock_timestamp()
    )
  `;
  return check.id;
}

async function observationsWithoutTenantRls(
  sql: Sql,
): Promise<{ organization_id: string; safe_error_retryable: boolean }[]> {
  return sql.begin(async (transaction) => {
    await transaction`
      ALTER TABLE rpc_consensus_provider_observations
        NO FORCE ROW LEVEL SECURITY
    `;
    const rows = await transaction<
      { organization_id: string; safe_error_retryable: boolean }[]
    >`
      SELECT organization_id::text, safe_error_retryable
      FROM rpc_consensus_provider_observations
      ORDER BY organization_id
    `;
    await transaction`
      ALTER TABLE rpc_consensus_provider_observations
        FORCE ROW LEVEL SECURITY
    `;
    return rows;
  });
}

function withSearchPath(
  urlString: string,
  schemaName: string,
  organizationId: string,
): string {
  const url = new URL(urlString);
  url.searchParams.set(
    "options",
    `-csearch_path=${schemaName} -cpayops.organization_id=${organizationId}`,
  );
  return url.toString();
}
