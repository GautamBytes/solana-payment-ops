import { readFile } from "node:fs/promises";
import postgres from "postgres";

const migration = {
  name: "1001_reconciliation_pilot",
  path: new URL(
    "../../migrations/0001_reconciliation_pilot.sql",
    import.meta.url,
  ),
} as const;

export async function runMigrations(databaseUrl: string): Promise<void> {
  const client = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  try {
    const lockKey = "payops:schema-migrations";
    await client`SELECT pg_advisory_lock(hashtextextended(${lockKey}, 0))`;
    try {
      await client`
        CREATE TABLE IF NOT EXISTS payops_schema_migrations (
          name text PRIMARY KEY,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `;
      const applied = await client<{ name: string }[]>`
        SELECT name FROM payops_schema_migrations WHERE name = ${migration.name}
      `;
      if (applied.length === 0) {
        const source = await readFile(migration.path, "utf8");
        await client.begin(async (transaction) => {
          await transaction.unsafe(source);
          await transaction`
            INSERT INTO payops_schema_migrations (name) VALUES (${migration.name})
          `;
        });
      }
    } finally {
      await client`SELECT pg_advisory_unlock(hashtextextended(${lockKey}, 0))`;
    }
  } finally {
    await client.end();
  }
}
