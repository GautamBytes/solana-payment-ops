import postgres from "postgres";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import { runMigrationSet } from "../src/index.js";

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
});

function withSearchPath(urlString: string, schemaName: string): string {
  const url = new URL(urlString);
  url.searchParams.set("options", `-csearch_path=${schemaName}`);
  return url.toString();
}
