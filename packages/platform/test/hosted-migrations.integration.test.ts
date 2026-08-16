import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { runHostedMigrations } from "../src/db/hosted-migrations.js";
import {
  cleanupTestProductionRoles,
  prepareTestProductionRoleBoundary,
} from "./production-role-test-helper.js";

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const schema = `payops_hosted_migrations_${process.pid}`;
const scopedUrl = databaseUrl ? withSearchPath(databaseUrl, schema) : undefined;
const admin = databaseUrl
  ? postgres(databaseUrl, { max: 1, onnotice: () => undefined })
  : undefined;
const scoped = scopedUrl
  ? postgres(scopedUrl, { max: 1, onnotice: () => undefined })
  : undefined;

const expectedMigrationNames = [
  "0001_durable_ingestion",
  "0002_finality_claim_token",
  "0003_pending_representation",
  "0004_rpc_consensus",
  "0005_rpc_consensus_error_retryability",
  "0006_rpc_consensus_internal_evidence",
  "2001_transactional_webhooks",
  "2002_lifecycle_contract_v0_1",
  "1001_reconciliation_pilot",
  "1002_semantic_parser_versions",
  "1003_strict_parser_versions",
  "1004_event_contract_bounds",
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
  "4016_public_analysis_rate_limits",
] as const;

describeDatabase("hosted migrations", () => {
  beforeAll(async () => {
    await admin!.unsafe(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    await prepareTestProductionRoleBoundary(scopedUrl!);
  });

  afterAll(async () => {
    await admin!.unsafe(
      `DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`,
    );
    await cleanupTestProductionRoles(scopedUrl!);
    await scoped?.end();
    await admin?.end();
  });

  test("applies all hosted migration sets exactly once across repeat runs", async () => {
    const first = await runHostedMigrations(scopedUrl!);
    const second = await runHostedMigrations(scopedUrl!);

    expect(first).toEqual(second);
    expect(first.migrationSets).toEqual([
      "ingestion",
      "webhooks",
      "reconciliation",
      "platform",
    ]);
    const rows = await scoped!<{ name: string; count: number }[]>`
      SELECT name, count(*)::integer AS count
      FROM payops_schema_migrations
      GROUP BY name
      ORDER BY name
    `;
    expect(rows).toHaveLength(expectedMigrationNames.length);
    expect(rows.map(({ name }) => name).sort()).toEqual(
      [...expectedMigrationNames].sort(),
    );
    expect(rows.every(({ count }) => count === 1)).toBe(true);
    const platformChecksums = await scoped!<{ count: number }[]>`
      SELECT count(*)::integer AS count
      FROM payops_schema_migrations
      WHERE name LIKE '4%' AND checksum_sha256 ~ '^[0-9a-f]{64}$'
    `;
    expect(platformChecksums).toEqual([{ count: 16 }]);
  });
});

function withSearchPath(url: string, searchPath: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("options", `-c search_path=${searchPath}`);
  return parsed.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
