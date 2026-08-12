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
import { runMigrationSet, runPlatformMigrations } from "../src/index.js";

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

describeDatabase("coordinated migrations", () => {
  beforeAll(async () => {
    await admin!.unsafe(`CREATE SCHEMA ${schema}`);
  });

  beforeEach(async () => {
    await admin!.unsafe(`DROP SCHEMA ${schema} CASCADE`);
    await admin!.unsafe(`CREATE SCHEMA ${schema}`);
  });

  afterAll(async () => {
    await admin!.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
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

  test("upgrades PR 7 through the exact checkout migration sequence without creating capabilities", async () => {
    await runIngestionMigrations(schemaDatabaseUrl!);
    await runReconciliationMigrations(schemaDatabaseUrl!);
    await runPlatformMigrations(schemaDatabaseUrl!);
    await runPlatformMigrations(schemaDatabaseUrl!);

    const migrations = await scoped!<{ name: string }[]>`
      SELECT name FROM payops_schema_migrations
      WHERE name LIKE '400%'
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
        ]})
      ORDER BY relname
    `;
    expect(tenantTables).toHaveLength(8);
    expect(
      tenantTables.every(({ rowSecurity, forced }) => rowSecurity && forced),
    ).toBe(true);
  });
});

function withSearchPath(urlString: string, schemaName: string): string {
  const url = new URL(urlString);
  url.searchParams.set("options", `-csearch_path=${schemaName}`);
  return url.toString();
}
