import { readFile } from "node:fs/promises";
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
      WHERE name LIKE '40%'
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
      "4010_merchant_operations",
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
          "exception_case_events",
          "ledger_accounts",
          "journal_entries",
          "journal_lines",
          "ledger_reconciliations",
          "evidence_packs",
          "accounting_exports",
        ]})
      ORDER BY relname
    `;
    expect(tenantTables).toHaveLength(15);
    expect(
      tenantTables.every(({ rowSecurity, forced }) => rowSecurity && forced),
    ).toBe(true);
  });

  test("preserves legacy closed exceptions with explicit unknown provenance", async () => {
    await runIngestionMigrations(schemaDatabaseUrl!);
    await runReconciliationMigrations(schemaDatabaseUrl!);
    const priorNames = [
      "4001_identity_organizations",
      "4002_tenant_scope_existing_data",
      "4003_merchants_customers_invoices",
      "4004_idempotency_and_audit",
      "4005_public_checkouts_and_rates",
      "4006_quotes_and_payment_attempts",
      "4007_hosted_reconciliation_and_projections",
      "4008_worker_jobs",
      "4009_payment_attempt_idempotency",
    ];
    await runMigrationSet(
      schemaDatabaseUrl!,
      await Promise.all(
        priorNames.map(async (name) => ({
          name,
          sql: await readFile(
            new URL(`../migrations/${name}.sql`, import.meta.url),
            "utf8",
          ),
        })),
      ),
    );
    await seedLegacyResolvedException();
    await runMigrationSet(schemaDatabaseUrl!, [
      {
        name: "4010_merchant_operations",
        sql: await readFile(
          new URL(
            "../migrations/4010_merchant_operations.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      },
    ]);

    const rows = await scoped!<
      {
        resolution_code: string;
        resolution_note: string;
        resolved_by: string;
        resolved_at: Date;
      }[]
    >`
      SELECT resolution_code, resolution_note, resolved_by, resolved_at
      FROM hosted_payment_exceptions
    `;
    expect(rows).toEqual([
      {
        resolution_code: "legacy_resolution_unknown",
        resolution_note:
          "Migrated from a pre-audit exception state; original resolution metadata is unavailable.",
        resolved_by: "system:migration-4010",
        resolved_at: new Date("2026-08-01T00:00:00.000Z"),
      },
    ]);
  });
});

async function seedLegacyResolvedException(): Promise<void> {
  const organizationId = "00000000-0000-4000-8000-000000000001";
  const customerId = "00000000-0000-4000-8000-000000000101";
  const walletId = "00000000-0000-4000-8000-000000000102";
  const invoiceId = "00000000-0000-4000-8000-000000000103";
  const checkoutId = "00000000-0000-4000-8000-000000000104";
  const attemptId = "00000000-0000-4000-8000-000000000105";
  const exceptionId = "00000000-0000-4000-8000-000000000106";
  await scoped!`SELECT set_config('payops.organization_id', ${organizationId}, false)`;
  await scoped!`
    INSERT INTO customers (id, organization_id, display_name, metadata)
    VALUES (${customerId}::uuid, ${organizationId}::uuid, 'Legacy buyer', '{}')
  `;
  await scoped!`
    INSERT INTO merchant_wallets (
      id, organization_id, address, cluster, status, verified_at
    ) VALUES (
      ${walletId}::uuid, ${organizationId}::uuid,
      '11111111111111111111111111111111', 'mainnet-beta', 'active', now()
    )
  `;
  await scoped!`
    INSERT INTO merchant_invoices (
      id, organization_id, public_reference, customer_id,
      settlement_wallet_id, accepted_asset_symbols, currency, status,
      subtotal_minor_units, tax_minor_units, total_minor_units, due_at
    ) VALUES (
      ${invoiceId}::uuid, ${organizationId}::uuid, 'INV-LEGACY',
      ${customerId}::uuid, ${walletId}::uuid, ARRAY['USDC']::text[],
      'USD', 'issued', 100, 0, 100, now()
    )
  `;
  await scoped!`
    INSERT INTO public_checkouts (
      id, organization_id, invoice_id, public_nonce, derivation_key_id, state
    ) VALUES (
      ${checkoutId}::uuid, ${organizationId}::uuid, ${invoiceId}::uuid,
      ${Buffer.alloc(32, 1)}, 'legacy', 'active'
    )
  `;
  await scoped!`
    INSERT INTO payment_attempts (
      id, public_attempt_id, organization_id, invoice_id, checkout_id,
      asset_symbol, reference_address, recipient_address, mint,
      recipient_token_account, state
    ) VALUES (
      ${attemptId}::uuid, '00000000-0000-4000-8000-000000000107'::uuid,
      ${organizationId}::uuid, ${invoiceId}::uuid, ${checkoutId}::uuid,
      'USDC', ${"2".repeat(32)}, ${"3".repeat(32)}, ${"4".repeat(32)},
      ${"5".repeat(32)}, 'exception'
    )
  `;
  await scoped!`
    INSERT INTO rpc_providers (
      id, cluster, endpoint_env, endpoint_label, active, created_at
    ) VALUES ('legacy-provider', 'mainnet-beta', 'LEGACY_RPC', 'legacy', true, now())
  `;
  const raw = await scoped!<{ id: string }[]>`
    INSERT INTO raw_transactions (
      provider_id, signature, commitment, digest, canonical_body, body,
      byte_length, retrieved_at
    ) VALUES (
      'legacy-provider', ${"6".repeat(64)}, 'finalized', ${"a".repeat(64)},
      '{}', '{}'::jsonb, 2, now()
    ) RETURNING id::text
  `;
  const event = await scoped!<{ id: string }[]>`
    INSERT INTO chain_events (
      event_id, cluster, signature, outer_instruction_index,
      inner_instruction_index, raw_transaction_id, current_state
    ) VALUES (
      'legacy-event', 'mainnet-beta', ${"6".repeat(64)}, 0, -1,
      ${raw[0]!.id}::bigint, 'finalized'
    ) RETURNING id::text
  `;
  await scoped!`
    INSERT INTO normalized_transfers (
      chain_event_id, parser_version, program_id, source_token_account,
      source_account_index, mint, destination_token_account,
      destination_account_index, authority, amount_base_units, decimals
    ) VALUES (
      ${event[0]!.id}::bigint, '1.0.0', ${"7".repeat(32)}, ${"8".repeat(32)},
      0, ${"4".repeat(32)}, ${"5".repeat(32)}, 1, ${"9".repeat(32)}, 100, 6
    )
  `;
  await scoped!`
    INSERT INTO hosted_payment_exceptions (
      id, organization_id, invoice_id, attempt_id, chain_event_id,
      parser_version, event_id, signature, outer_instruction_index,
      inner_instruction_index, amount_base_units, rule_code, rule_version,
      review_state, created_at
    ) VALUES (
      ${exceptionId}::uuid, ${organizationId}::uuid, ${invoiceId}::uuid,
      ${attemptId}::uuid, ${event[0]!.id}::bigint, '1.0.0', 'legacy-event',
      ${"6".repeat(64)}, 0, NULL, 100, 'wrong_amount', '1.0.0', 'resolved',
      '2026-08-01T00:00:00.000Z'
    )
  `;
}

function withSearchPath(urlString: string, schemaName: string): string {
  const url = new URL(urlString);
  url.searchParams.set("options", `-csearch_path=${schemaName}`);
  return url.toString();
}
