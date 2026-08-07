import { randomUUID } from "node:crypto";
import { runMigrations as runIngestionMigrations } from "@payops/ingestion";
import postgres, { type Sql } from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { runMigrations as runReconciliationMigrations } from "../src/storage/migrate.js";

const baseDatabaseUrl =
  process.env.DATABASE_URL ??
  "postgres://payops:payops@127.0.0.1:55432/payops_test";
const adminSql = postgres(baseDatabaseUrl, { max: 1 });
const astral = "\u{1F680}";

afterAll(async () => {
  await adminSql.end();
});

describe("event-contract bounds migration", () => {
  it("accepts legacy astral identity at the Unicode code-point boundaries", async () => {
    await withLegacySchema(
      astral.repeat(128),
      astral.repeat(512),
      async ({ databaseUrl, sql }) => {
        await runReconciliationMigrations(databaseUrl);
        await runReconciliationMigrations(databaseUrl);

        await expect(migrationCount(sql)).resolves.toBe(1);
        await expect(
          sql<{ invoice_length: number; customer_length: number }[]>`
            SELECT
              char_length(invoice_id)::integer AS invoice_length,
              char_length(customer_id)::integer AS customer_length
            FROM reconciliation_invoices
          `,
        ).resolves.toEqual([{ invoice_length: 128, customer_length: 512 }]);
      },
    );
  });

  it.each([
    ["invoice ID", astral.repeat(129), "customer"],
    ["customer ID", "invoice", astral.repeat(513)],
  ])(
    "fails safely with remediation for an over-bound legacy astral %s",
    async (_name, invoiceId, customerId) => {
      await withLegacySchema(
        invoiceId,
        customerId,
        async ({ databaseUrl, sql }) => {
          await expect(
            runReconciliationMigrations(databaseUrl),
          ).rejects.toMatchObject({
            message:
              "reconciliation invoice identity exceeds webhook event contract bounds",
            hint: "Shorten invoice_id to 128 and customer_id to 512 characters before retrying migration 1004.",
          });
          await expect(migrationCount(sql)).resolves.toBe(0);
          await expect(
            sql<{ count: number }[]>`
              SELECT count(*)::integer AS count
              FROM reconciliation_invoices
            `,
          ).resolves.toEqual([{ count: 1 }]);
        },
      );
    },
  );

  it("records 1004 when named constraints exist but its ledger row is missing", async () => {
    await withLegacySchema(
      "legacy-valid",
      "customer-valid",
      async ({ databaseUrl, sql }) => {
        await sql.unsafe(`
          ALTER TABLE reconciliation_invoices
            ADD CONSTRAINT reconciliation_invoices_invoice_id_event_bound
              CHECK (char_length(invoice_id) BETWEEN 1 AND 128),
            ADD CONSTRAINT reconciliation_invoices_customer_id_event_bound
              CHECK (char_length(customer_id) BETWEEN 1 AND 512)
        `);

        await runReconciliationMigrations(databaseUrl);
        await runReconciliationMigrations(databaseUrl);

        await expect(migrationCount(sql)).resolves.toBe(1);
      },
    );
  });
});

async function withLegacySchema(
  invoiceId: string,
  customerId: string,
  run: (context: {
    readonly databaseUrl: string;
    readonly sql: Sql;
  }) => Promise<void>,
): Promise<void> {
  const schema = `legacy_event_bounds_${randomUUID().replaceAll("-", "")}`;
  const databaseUrl = databaseUrlForSchema(baseDatabaseUrl, schema);
  const sql = postgres(databaseUrl, { max: 1 });
  await adminSql.unsafe(`CREATE SCHEMA ${schema}`);
  try {
    await runIngestionMigrations(databaseUrl);
    await sql.unsafe(`
      CREATE TABLE reconciliation_invoices (
        invoice_id text PRIMARY KEY,
        customer_id text NOT NULL
      )
    `);
    await sql`
      INSERT INTO reconciliation_invoices (invoice_id, customer_id)
      VALUES (${invoiceId}, ${customerId})
    `;
    await sql`
      INSERT INTO payops_schema_migrations (name)
      VALUES
        ('1001_reconciliation_pilot'),
        ('1002_semantic_parser_versions'),
        ('1003_strict_parser_versions')
    `;
    await run({ databaseUrl, sql });
  } finally {
    await sql.end();
    await adminSql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  }
}

async function migrationCount(sql: Sql): Promise<number> {
  const [row] = await sql<{ count: number }[]>`
    SELECT count(*)::integer AS count
    FROM payops_schema_migrations
    WHERE name = '1004_event_contract_bounds'
  `;
  return row?.count ?? 0;
}

function databaseUrlForSchema(databaseUrl: string, schemaName: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set("options", `-csearch_path=${schemaName}`);
  return url.toString();
}
