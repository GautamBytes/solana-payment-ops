import { readFile } from "node:fs/promises";
import { runMigrations as runIngestionMigrations } from "@payops/ingestion";
import { runMigrations as runReconciliationMigrations } from "@payops/reconciliation";
import { runMigrations as runWebhookMigrations } from "@payops/webhooks";
import postgres from "postgres";

const localMigration = {
  name: "3001_shadow_audits",
  path: new URL("../../migrations/0001_shadow_audits.sql", import.meta.url),
} as const;

export async function runPilotMigrations(databaseUrl: string): Promise<void> {
  await runIngestionMigrations(databaseUrl);
  await runWebhookMigrations(databaseUrl);
  await runReconciliationMigrations(databaseUrl);
  await runLocalPilotMigrations(databaseUrl);
}

async function runLocalPilotMigrations(databaseUrl: string): Promise<void> {
  const client = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  const lockKey = "payops:schema-migrations";
  try {
    await client`SELECT pg_advisory_lock(hashtextextended(${lockKey}, 0))`;
    try {
      await client`
        CREATE TABLE IF NOT EXISTS payops_schema_migrations (
          name text PRIMARY KEY,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `;
      const applied = await client<{ name: string }[]>`
        SELECT name FROM payops_schema_migrations
        WHERE name = ${localMigration.name}
      `;
      if (applied.length === 0) {
        const source = await readFile(localMigration.path, "utf8");
        await client.begin(async (transaction) => {
          await transaction.unsafe(source);
          await transaction`
            INSERT INTO payops_schema_migrations (name)
            VALUES (${localMigration.name})
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
