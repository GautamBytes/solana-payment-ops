import { readFile } from "node:fs/promises";
import postgres from "postgres";

const migrations = [
  {
    name: "2001_transactional_webhooks",
    path: new URL(
      "../../migrations/0001_transactional_webhooks.sql",
      import.meta.url,
    ),
  },
  {
    name: "2002_lifecycle_contract_v0_1",
    path: new URL(
      "../../migrations/0002_lifecycle_contract_v0_1.sql",
      import.meta.url,
    ),
  },
] as const;

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
      for (const migration of migrations) {
        const applied = await client<{ name: string }[]>`
          SELECT name
          FROM payops_schema_migrations
          WHERE name = ${migration.name}
        `;
        if (applied.length === 0) {
          const source = await readFile(migration.path, "utf8");
          await client.begin(async (transaction) => {
            await transaction.unsafe(source);
            await transaction`
              INSERT INTO payops_schema_migrations (name)
              VALUES (${migration.name})
            `;
          });
        }
      }
    } finally {
      await client`SELECT pg_advisory_unlock(hashtextextended(${lockKey}, 0))`;
    }
  } finally {
    await client.end();
  }
}
