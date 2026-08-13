import { randomUUID } from "node:crypto";
import { parseLifecycleEventEnvelope } from "@payops/contracts";
import { runMigrations as runIngestionMigrations } from "@payops/ingestion";
import { runMigrations as runReconciliationMigrations } from "@payops/reconciliation";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  CustomerStore,
  InvoiceStore,
  OrganizationDatabase,
  assetBySymbol,
} from "../src/index.js";
import {
  cleanupTestProductionRoles,
  runTestPlatformMigrations,
} from "./production-role-test-helper.js";

const baseDatabaseUrl = process.env.DATABASE_URL;
const describeDatabase = baseDatabaseUrl ? describe : describe.skip;
const schema = `payops_invoices_${process.pid}`;
const databaseUrl = baseDatabaseUrl
  ? withSearchPath(baseDatabaseUrl, schema)
  : undefined;
const admin = baseDatabaseUrl
  ? postgres(baseDatabaseUrl, { max: 1, onnotice: () => undefined })
  : undefined;
const organizationId = "00000000-0000-4000-8000-000000000001";

describeDatabase("invoice store", () => {
  beforeAll(async () => {
    await admin!.unsafe(`CREATE SCHEMA ${schema}`);
  });

  beforeEach(async () => {
    await admin!.unsafe(`DROP SCHEMA ${schema} CASCADE`);
    await admin!.unsafe(`CREATE SCHEMA ${schema}`);
    await runIngestionMigrations(databaseUrl!);
    await runReconciliationMigrations(databaseUrl!);
    await runTestPlatformMigrations(databaseUrl!);
  });

  afterAll(async () => {
    await admin!.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await cleanupTestProductionRoles(databaseUrl!);
    await admin?.end();
  });

  it("creates, issues, and cancels with immutable snapshots and lifecycle events", async () => {
    const database = new OrganizationDatabase(databaseUrl!, { max: 3 });
    const invoices = new InvoiceStore(database);
    const seeded = await seedMerchant(database);
    const actorId = randomUUID();
    const createdAt = new Date("2026-08-12T00:00:00.000Z");
    try {
      const draft = await invoices.create({
        organizationId,
        actorKind: "session",
        actorId,
        externalId: "invoice-001",
        customerId: seeded.customerId,
        settlementWalletId: seeded.walletId,
        acceptedAssetSymbols: ["USDC", "USDT"],
        currency: "INR",
        lines: [
          {
            description: "Implementation",
            quantity: "1.5",
            unitPriceMinorUnits: "10000",
            taxLabel: "GST",
            taxMinorUnits: "2700",
          },
        ],
        dueAt: new Date("2026-08-20T00:00:00.000Z"),
        expectedTotals: {
          subtotalMinorUnits: "15000",
          taxMinorUnits: "2700",
          totalMinorUnits: "17700",
        },
        now: createdAt,
        auditRequestId: randomUUID(),
      });
      expect(draft).toMatchObject({
        status: "draft",
        version: 1,
        totalMinorUnits: "17700",
      });
      const issued = await invoices.issue({
        organizationId,
        actorKind: "session",
        actorId,
        invoiceId: draft.id,
        now: new Date("2026-08-12T00:01:00.000Z"),
        auditRequestId: randomUUID(),
      });
      expect(issued.invoice).toMatchObject({ status: "issued", version: 2 });
      expect(issued.snapshot).toMatchObject({
        customer: { displayName: "Invoice Buyer" },
        acceptedAssetSymbols: ["USDC", "USDT"],
        settlementWalletId: seeded.walletId,
      });
      const cancelled = await invoices.cancel({
        organizationId,
        actorKind: "session",
        actorId,
        invoiceId: draft.id,
        reasonCode: "customer_request",
        now: new Date("2026-08-12T00:02:00.000Z"),
        auditRequestId: randomUUID(),
      });
      expect(cancelled).toMatchObject({
        status: "cancelled",
        version: 3,
        cancellationReason: "customer_request",
      });
      await expect(
        invoices.cancel({
          organizationId,
          actorKind: "session",
          actorId,
          invoiceId: draft.id,
          reasonCode: "customer_request",
          now: new Date("2026-08-12T00:03:00.000Z"),
        }),
      ).rejects.toMatchObject({ code: "invoice_already_cancelled" });

      await database.transaction(
        { organizationId, actorId },
        async (transaction) => {
          const rows = await transaction<
            { event_type: string; payload: string; source_version: number }[]
          >`
            SELECT event_type, payload, source_version FROM webhook_events
            WHERE source_id = ${draft.id}
            ORDER BY source_version
          `;
          expect(
            rows.map((row) => [row.event_type, row.source_version]),
          ).toEqual([
            ["invoice.issued", 2],
            ["invoice.cancelled", 3],
          ]);
          for (const row of rows) {
            expect(
              parseLifecycleEventEnvelope(JSON.parse(row.payload)),
            ).not.toBeNull();
          }
          await expect(
            transaction<{ count: number }[]>`
              SELECT count(*)::integer AS count
              FROM merchant_invoice_issued_snapshots WHERE invoice_id = ${draft.id}::uuid
            `,
          ).resolves.toEqual([{ count: 1 }]);
          await expect(
            transaction<{ count: number }[]>`
              SELECT count(*)::integer AS count FROM webhook_deliveries
              WHERE event_id IN (SELECT id FROM webhook_events WHERE source_id = ${draft.id})
            `,
          ).resolves.toEqual([{ count: 2 }]);
          await expect(
            transaction<
              { source_type: string; debit: string; credit: string }[]
            >`
              SELECT entry.source_type,
                sum(line.debit_minor_units)::text AS debit,
                sum(line.credit_minor_units)::text AS credit
              FROM journal_entries AS entry
              JOIN journal_lines AS line
                ON line.organization_id = entry.organization_id
                AND line.journal_entry_id = entry.id
              WHERE entry.source_id = ${draft.id}
              GROUP BY entry.id ORDER BY entry.occurred_at
            `,
          ).resolves.toEqual([
            { source_type: "invoice_issued", debit: "17700", credit: "17700" },
            {
              source_type: "invoice_cancelled",
              debit: "17700",
              credit: "17700",
            },
          ]);
        },
      );
    } finally {
      await database.close();
    }
  });

  it("rolls back issuance when the transactional outbox rejects the event", async () => {
    const database = new OrganizationDatabase(databaseUrl!, { max: 3 });
    const invoices = new InvoiceStore(database);
    const seeded = await seedMerchant(database);
    const actorId = randomUUID();
    try {
      const draft = await invoices.create({
        organizationId,
        actorKind: "session",
        actorId,
        customerId: seeded.customerId,
        settlementWalletId: seeded.walletId,
        acceptedAssetSymbols: ["USDC"],
        currency: "USD",
        lines: [
          {
            description: "Service",
            quantity: "1",
            unitPriceMinorUnits: "100",
            taxMinorUnits: "0",
          },
        ],
        dueAt: new Date("2026-08-20T00:00:00.000Z"),
        now: new Date("2026-08-12T00:00:00.000Z"),
      });
      const scoped = postgres(databaseUrl!, { max: 1 });
      await scoped.unsafe(`
        CREATE FUNCTION reject_test_invoice_event() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'forced outbox failure'; END $$;
        CREATE TRIGGER reject_test_invoice_event
        BEFORE INSERT ON webhook_events
        FOR EACH ROW EXECUTE FUNCTION reject_test_invoice_event();
      `);
      await scoped.end();
      await expect(
        invoices.issue({
          organizationId,
          actorKind: "session",
          actorId,
          invoiceId: draft.id,
          now: new Date("2026-08-12T00:01:00.000Z"),
        }),
      ).rejects.toMatchObject({ code: "invoice_store_unavailable" });
      await expect(
        invoices.get({ organizationId, actorId, invoiceId: draft.id }),
      ).resolves.toMatchObject({ status: "draft", version: 1, issuedAt: null });
    } finally {
      await database.close();
    }
  });
});

async function seedMerchant(database: OrganizationDatabase): Promise<{
  readonly customerId: string;
  readonly walletId: string;
}> {
  const actorId = randomUUID();
  const customer = await new CustomerStore(database).create({
    organizationId,
    actorKind: "session",
    actorId,
    displayName: "Invoice Buyer",
    now: new Date("2026-08-12T00:00:00.000Z"),
  });
  const walletId = randomUUID();
  await database.transaction(
    { organizationId, actorId },
    async (transaction) => {
      await transaction`
      INSERT INTO merchant_wallets (
        id, organization_id, address, cluster, status, verified_at,
        created_at, updated_at
      ) VALUES (
        ${walletId}::uuid, ${organizationId}::uuid,
        '11111111111111111111111111111111', 'mainnet-beta', 'active',
        now(), now(), now()
      )
    `;
      for (const symbol of ["USDC", "USDT"] as const) {
        const asset = assetBySymbol(symbol);
        await transaction`
        INSERT INTO merchant_wallet_assets (
          organization_id, wallet_id, symbol, mint, token_account,
          decimals, token_program, created_at
        ) VALUES (
          ${organizationId}::uuid, ${walletId}::uuid, ${symbol}, ${asset.mint},
          ${`${symbol}-test-token-account`}, 6, ${asset.tokenProgram}, now()
        )
      `;
      }
      await transaction`
      INSERT INTO webhook_endpoints (
        id, url, secret_env, state, created_at, updated_at, organization_id
      ) VALUES (
        'invoice-test-endpoint', 'https://receiver.example/webhooks',
        'TEST_WEBHOOK_SECRET', 'active', now(), now(), ${organizationId}::uuid
      )
    `;
    },
  );
  return { customerId: customer.id, walletId };
}

function withSearchPath(urlString: string, schemaName: string): string {
  const url = new URL(urlString);
  url.searchParams.set("options", `-csearch_path=${schemaName}`);
  return url.toString();
}
