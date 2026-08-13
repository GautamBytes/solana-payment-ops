import { readFile } from "node:fs/promises";
import postgres from "postgres";

const migrations = [
  {
    name: "0001_durable_ingestion",
    path: new URL(
      "../../migrations/0001_durable_ingestion.sql",
      import.meta.url,
    ),
  },
  {
    name: "0002_finality_claim_token",
    path: new URL(
      "../../migrations/0002_finality_claim_token.sql",
      import.meta.url,
    ),
  },
  {
    name: "0003_pending_representation",
    path: new URL(
      "../../migrations/0003_pending_representation.sql",
      import.meta.url,
    ),
  },
  {
    name: "0004_rpc_consensus",
    path: new URL("../../migrations/0004_rpc_consensus.sql", import.meta.url),
  },
  {
    name: "0005_rpc_consensus_error_retryability",
    path: new URL(
      "../../migrations/0005_rpc_consensus_error_retryability.sql",
      import.meta.url,
    ),
  },
  {
    name: "0006_rpc_consensus_internal_evidence",
    path: new URL(
      "../../migrations/0006_rpc_consensus_internal_evidence.sql",
      import.meta.url,
    ),
  },
] as const;

export async function runMigrations(databaseUrl: string): Promise<void> {
  const client = postgres(databaseUrl, {
    max: 1,
    onnotice: () => undefined,
  });
  try {
    const lockKey = "payops:schema-migrations";
    await client`
      SELECT pg_advisory_lock(hashtextextended(${lockKey}, 0))
    `;
    try {
      await client`
        CREATE TABLE IF NOT EXISTS payops_schema_migrations (
          name text PRIMARY KEY,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `;
      for (const definition of migrations) {
        const applied = await client<{ name: string }[]>`
          SELECT name FROM payops_schema_migrations
          WHERE name = ${definition.name}
        `;
        if (applied.length > 0) continue;
        const migration = await readFile(definition.path, "utf8");
        await client.begin(async (transaction) => {
          await transaction.unsafe(migration);
          await transaction`
            INSERT INTO payops_schema_migrations (name)
            VALUES (${definition.name})
          `;
        });
      }
    } finally {
      await client`
        SELECT pg_advisory_unlock(hashtextextended(${lockKey}, 0))
      `;
    }
  } finally {
    await client.end();
  }
}
