import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";

export interface MigrationDefinition {
  readonly name: string;
  readonly sql: string;
}

export interface MigrationMetadata {
  readonly name: string;
  readonly checksumSha256: string;
}

export class MigrationError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "MigrationError";
    this.code = code;
  }
}

export function migrationChecksum(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

export async function runMigrationSet(
  databaseUrl: string,
  migrations: readonly MigrationDefinition[],
): Promise<void> {
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
      await client`
        ALTER TABLE payops_schema_migrations
        ADD COLUMN IF NOT EXISTS checksum_sha256 text
      `;

      for (const migration of migrations) {
        const checksum = migrationChecksum(migration.sql);
        const applied = await client<{ checksum_sha256: string | null }[]>`
          SELECT checksum_sha256
          FROM payops_schema_migrations
          WHERE name = ${migration.name}
        `;

        if (applied.length > 0) {
          if (applied[0]?.checksum_sha256 !== checksum) {
            throw new MigrationError("migration_checksum_mismatch");
          }
          continue;
        }

        await client.begin(async (transaction) => {
          await transaction.unsafe(migration.sql);
          await transaction`
            INSERT INTO payops_schema_migrations (name, checksum_sha256)
            VALUES (${migration.name}, ${checksum})
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

export const PLATFORM_MIGRATION_NAMES = [
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
] as const;

async function platformMigrationDefinitions(): Promise<MigrationDefinition[]> {
  return Promise.all(
    PLATFORM_MIGRATION_NAMES.map(async (name) => ({
      name,
      sql: await readFile(
        new URL(`../../migrations/${name}.sql`, import.meta.url),
        "utf8",
      ),
    })),
  );
}

export async function platformMigrationMetadata(): Promise<
  readonly MigrationMetadata[]
> {
  return (await platformMigrationDefinitions()).map(({ name, sql }) => ({
    name,
    checksumSha256: migrationChecksum(sql),
  }));
}

export async function runPlatformMigrations(
  databaseUrl: string,
): Promise<void> {
  await runMigrationSet(databaseUrl, await platformMigrationDefinitions());
}
