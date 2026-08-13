import {
  PostgresIngestionStore,
  runMigrations as runIngestionMigrations,
} from "@payops/ingestion";
import {
  PostgresReconciliationStore,
  runMigrations as runReconciliationMigrations,
} from "@payops/reconciliation";
import { PostgresWebhookStore } from "@payops/webhooks";
import postgres from "postgres";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import {
  cleanupTestProductionRoles,
  runTestPlatformMigrations,
} from "./production-role-test-helper.js";

const defaultOrganizationId = "00000000-0000-4000-8000-000000000001";
const secondOrganizationId = "00000000-0000-4000-8000-000000000002";
const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const schema = `payops_tenant_rls_${process.pid}`;
const apiRole = `payops_api_test_${process.pid}`;
const storeRole = `payops_store_test_${process.pid}`;
const storePassword = "payops-store-test-only-password";
const schemaDatabaseUrl = databaseUrl
  ? withSearchPath(databaseUrl, schema)
  : undefined;
const admin = databaseUrl
  ? postgres(databaseUrl, { max: 1, onnotice: () => undefined })
  : undefined;

describeDatabase("tenant migration and row-level security", () => {
  beforeAll(async () => {
    await admin!.unsafe(`CREATE SCHEMA ${schema}`);
    await admin!.unsafe(`CREATE ROLE ${apiRole} NOLOGIN`);
    await admin!.unsafe(
      `CREATE ROLE ${storeRole} LOGIN PASSWORD '${storePassword}'`,
    );
  });

  beforeEach(async () => {
    await admin!.unsafe(`DROP SCHEMA ${schema} CASCADE`);
    await admin!.unsafe(`CREATE SCHEMA ${schema}`);
    await runIngestionMigrations(schemaDatabaseUrl!);
    await runReconciliationMigrations(schemaDatabaseUrl!);
  });

  afterAll(async () => {
    await admin!.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await cleanupTestProductionRoles(schemaDatabaseUrl!);
    await admin!.unsafe(`DROP ROLE IF EXISTS ${apiRole}`);
    await admin!.unsafe(`DROP ROLE IF EXISTS ${storeRole}`);
    await admin?.end();
  });

  test("backfills every existing tenant root into the self-host organization", async () => {
    const sql = postgres(schemaDatabaseUrl!, { max: 1 });
    try {
      await seedPr6Roots(sql);
      await runTestPlatformMigrations(schemaDatabaseUrl!);

      for (const table of [
        "watch_targets",
        "reconciliation_invoices",
        "reconciliation_runs",
        "webhook_endpoints",
        "webhook_events",
      ]) {
        const rows = await sql.unsafe<{ organization_id: string }[]>(
          `SELECT organization_id FROM ${table}`,
        );
        expect(rows).not.toHaveLength(0);
        expect(
          rows.every((row) => row.organization_id === defaultOrganizationId),
        ).toBe(true);
      }
    } finally {
      await sql.end();
    }
  });

  test("fails closed without tenant context and isolates organizations", async () => {
    await runTestPlatformMigrations(schemaDatabaseUrl!);
    const sql = postgres(schemaDatabaseUrl!, { max: 1 });
    try {
      await sql`
        INSERT INTO organization (id, name, slug, created_at)
        VALUES (${secondOrganizationId}, 'Second', 'second', now())
      `;
      await sql`
        INSERT INTO rpc_providers (id, cluster, endpoint_env, endpoint_label)
        VALUES ('provider', 'mainnet-beta', 'RPC_URL', 'test')
      `;

      await setOrganization(sql, defaultOrganizationId);
      await seedTenantWatchTarget(
        sql,
        defaultOrganizationId,
        "target-a",
        "address-a",
      );
      await setOrganization(sql, secondOrganizationId);
      await seedTenantWatchTarget(
        sql,
        secondOrganizationId,
        "target-b",
        "address-b",
      );

      await sql.unsafe(`GRANT USAGE ON SCHEMA ${schema} TO ${apiRole}`);
      await sql.unsafe(`GRANT SELECT ON watch_targets TO ${apiRole}`);
      await sql.unsafe(`SET ROLE ${apiRole}`);

      await sql`SELECT set_config('payops.organization_id', '', false)`;
      const absent = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM watch_targets
      `;
      expect(absent[0]?.count).toBe("0");

      await sql`SELECT set_config('payops.organization_id', 'not-a-uuid', false)`;
      const malformed = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM watch_targets
      `;
      expect(malformed[0]?.count).toBe("0");

      await setOrganization(sql, defaultOrganizationId);
      const first = await sql<{ id: string }[]>`SELECT id FROM watch_targets`;
      expect(first.map((row) => row.id)).toEqual(["target-a"]);

      await setOrganization(sql, secondOrganizationId);
      const second = await sql<{ id: string }[]>`SELECT id FROM watch_targets`;
      expect(second.map((row) => row.id)).toEqual(["target-b"]);
      await sql`RESET ROLE`;
    } finally {
      await sql.end();
    }
  });

  test("tenant-scoped stores and derived joins cannot cross organization boundaries", async () => {
    await runTestPlatformMigrations(schemaDatabaseUrl!);
    const sql = postgres(schemaDatabaseUrl!, { max: 1 });
    const storeDatabaseUrl = withCredentials(
      schemaDatabaseUrl!,
      storeRole,
      storePassword,
    );
    const ingestionA = new PostgresIngestionStore({
      databaseUrl: storeDatabaseUrl,
      organizationId: defaultOrganizationId,
    });
    const ingestionB = new PostgresIngestionStore({
      databaseUrl: storeDatabaseUrl,
      organizationId: secondOrganizationId,
    });
    const reconciliationA = new PostgresReconciliationStore({
      databaseUrl: storeDatabaseUrl,
      organizationId: defaultOrganizationId,
    });
    const reconciliationB = new PostgresReconciliationStore({
      databaseUrl: storeDatabaseUrl,
      organizationId: secondOrganizationId,
    });
    const webhooksA = new PostgresWebhookStore({
      databaseUrl: storeDatabaseUrl,
      organizationId: defaultOrganizationId,
    });
    const webhooksB = new PostgresWebhookStore({
      databaseUrl: storeDatabaseUrl,
      organizationId: secondOrganizationId,
    });
    try {
      await sql`
        INSERT INTO organization (id, name, slug, created_at)
        VALUES (${secondOrganizationId}, 'Second', 'second', now())
      `;
      await sql`
        INSERT INTO rpc_providers (id, cluster, endpoint_env, endpoint_label)
        VALUES ('provider', 'mainnet-beta', 'RPC_URL', 'test')
      `;
      await grantStoreAccess(sql);

      const watchInput = {
        providerId: "provider",
        cluster: "mainnet-beta" as const,
        address: "shared-address",
        cutoverSlot: 0n,
        cutoverSignature: null,
        overlapSlots: 32n,
        createdAt: new Date("2026-08-11T00:00:00.000Z"),
      };
      await ingestionA.addWatchTarget({ ...watchInput, id: "watch-a" });
      await ingestionB.addWatchTarget({ ...watchInput, id: "watch-b" });
      await expect(ingestionA.getWatchTarget("watch-b")).resolves.toBeNull();
      await expect(ingestionB.getWatchTarget("watch-a")).resolves.toBeNull();
      await expect(
        ingestionA.getWatchCoverageSummaries(["watch-b"]),
      ).rejects.toMatchObject({ code: "invalid_configuration" });

      await setOrganization(sql, secondOrganizationId);
      await sql`
        INSERT INTO discovered_signatures (
          watch_target_id, provider_id, signature, slot,
          representation_class, finality_state, observed_at
        ) VALUES (
          'watch-b', 'provider', 'signature-b', 1,
          'parsed', 'confirmed', now()
        )
      `;
      await expect(
        ingestionA.inspectSignature("signature-b"),
      ).resolves.toBeNull();

      const invoiceInput = {
        customerId: "customer",
        expectedMint: "mint",
        destinationTokenAccount: "destination",
        amountBaseUnits: 10n,
        referenceAddress: "shared-reference",
        issuedAt: new Date("2026-08-11T00:00:00.000Z"),
        dueAt: new Date("2026-08-12T00:00:00.000Z"),
      };
      await reconciliationA.importInvoices(
        [{ ...invoiceInput, invoiceId: "invoice-a" }],
        new Date("2026-08-11T00:01:00.000Z"),
      );
      await reconciliationB.importInvoices(
        [{ ...invoiceInput, invoiceId: "invoice-b" }],
        new Date("2026-08-11T00:01:00.000Z"),
      );
      await expect(reconciliationA.listInvoices()).resolves.toMatchObject([
        { invoiceId: "invoice-a" },
      ]);
      await expect(reconciliationB.listInvoices()).resolves.toMatchObject([
        { invoiceId: "invoice-b" },
      ]);

      await webhooksA.addEndpoint(
        {
          id: "endpoint-a",
          url: "https://receiver-a.example/webhook",
          secretEnv: "WEBHOOK_SECRET_A",
        },
        new Date("2026-08-11T00:02:00.000Z"),
      );
      await webhooksB.addEndpoint(
        {
          id: "endpoint-b",
          url: "https://receiver-b.example/webhook",
          secretEnv: "WEBHOOK_SECRET_B",
        },
        new Date("2026-08-11T00:02:00.000Z"),
      );
      await expect(webhooksA.listEndpoints()).resolves.toMatchObject([
        { id: "endpoint-a" },
      ]);
      await expect(webhooksB.listEndpoints()).resolves.toMatchObject([
        { id: "endpoint-b" },
      ]);
    } finally {
      await Promise.all([
        ingestionA.close(),
        ingestionB.close(),
        reconciliationA.close(),
        reconciliationB.close(),
        webhooksA.close(),
        webhooksB.close(),
      ]);
      await sql.end();
    }
  });
});

async function grantStoreAccess(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(`GRANT USAGE ON SCHEMA ${schema} TO ${storeRole}`);
  await sql.unsafe(
    `GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ${storeRole}`,
  );
  await sql.unsafe(
    `GRANT INSERT, UPDATE ON watch_targets, reconciliation_invoices, webhook_endpoints TO ${storeRole}`,
  );
}

async function seedPr6Roots(sql: postgres.Sql): Promise<void> {
  await sql`
    INSERT INTO rpc_providers (id, cluster, endpoint_env, endpoint_label)
    VALUES ('provider', 'mainnet-beta', 'RPC_URL', 'test')
  `;
  await seedLegacyWatchTarget(sql, "legacy-target", "legacy-address");
  await sql`
    INSERT INTO reconciliation_invoices (
      invoice_id, customer_id, expected_mint, destination_token_account,
      amount_base_units, reference_address, issued_at, due_at, row_digest,
      imported_at
    ) VALUES (
      'legacy-invoice', 'customer', 'mint', 'destination', 1, 'reference',
      now(), now() + interval '1 day', repeat('a', 64), now()
    )
  `;
  await sql`
    INSERT INTO reconciliation_runs (id, started_at)
    VALUES ('00000000-0000-4000-8000-000000000010', now())
  `;
  await sql`
    INSERT INTO webhook_endpoints (
      id, url, secret_env, state, created_at, updated_at
    ) VALUES (
      'legacy-endpoint', 'https://receiver.example', 'WEBHOOK_SECRET',
      'active', now(), now()
    )
  `;
  await sql`
    INSERT INTO webhook_events (
      id, event_type, source_type, source_id, source_version, payload,
      payload_digest, occurred_at, created_at
    ) VALUES (
      '00000000-0000-4000-8000-000000000020', 'invoice.issued', 'invoice',
      '00000000-0000-4000-8000-000000000030', 1, '{}', repeat('b', 64),
      now(), now()
    )
  `;
}

async function seedLegacyWatchTarget(
  sql: postgres.Sql,
  id: string,
  address: string,
): Promise<void> {
  await sql`
    INSERT INTO watch_targets (
      id, provider_id, cluster, address, cutover_slot, overlap_slots, created_at
    ) VALUES (${id}, 'provider', 'mainnet-beta', ${address}, 0, 32, now())
  `;
}

async function seedTenantWatchTarget(
  sql: postgres.Sql,
  organizationId: string,
  id: string,
  address: string,
): Promise<void> {
  await sql`
    INSERT INTO watch_targets (
      organization_id, id, provider_id, cluster, address, cutover_slot,
      overlap_slots, created_at
    ) VALUES (
      ${organizationId}, ${id}, 'provider', 'mainnet-beta', ${address}, 0, 32,
      now()
    )
  `;
}

async function setOrganization(
  sql: postgres.Sql,
  organizationId: string,
): Promise<void> {
  await sql`SELECT set_config('payops.organization_id', ${organizationId}, false)`;
}

function withSearchPath(urlString: string, schemaName: string): string {
  const url = new URL(urlString);
  url.searchParams.set("options", `-csearch_path=${schemaName}`);
  return url.toString();
}

function withCredentials(
  urlString: string,
  username: string,
  password: string,
): string {
  const url = new URL(urlString);
  url.username = username;
  url.password = password;
  return url.toString();
}
