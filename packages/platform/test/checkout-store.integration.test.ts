import { randomUUID } from "node:crypto";
import { runMigrations as runIngestionMigrations } from "@payops/ingestion";
import { runMigrations as runReconciliationMigrations } from "@payops/reconciliation";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CheckoutStore, OrganizationDatabase } from "../src/index.js";
import {
  cleanupTestProductionRoles,
  runTestPlatformMigrations,
} from "./production-role-test-helper.js";

const baseDatabaseUrl = process.env.DATABASE_URL;
const describeDatabase = baseDatabaseUrl ? describe : describe.skip;
const schema = `payops_checkout_store_${process.pid}`;
const databaseUrl = baseDatabaseUrl
  ? withSearchPath(baseDatabaseUrl, schema)
  : undefined;
const admin = baseDatabaseUrl
  ? postgres(baseDatabaseUrl, { max: 1, onnotice: () => undefined })
  : undefined;
const organizationId = "00000000-0000-4000-8000-000000000001";

describeDatabase("checkout store", () => {
  let database: OrganizationDatabase;
  let store: CheckoutStore;

  beforeAll(async () => {
    await admin!.unsafe(`CREATE SCHEMA ${schema}`);
  });
  beforeEach(async () => {
    await store?.close();
    await database?.close();
    await admin!.unsafe(`DROP SCHEMA ${schema} CASCADE`);
    await admin!.unsafe(`CREATE SCHEMA ${schema}`);
    await runIngestionMigrations(databaseUrl!);
    await runReconciliationMigrations(databaseUrl!);
    await runTestPlatformMigrations(databaseUrl!);
    database = new OrganizationDatabase(databaseUrl!, { max: 1 });
    store = new CheckoutStore(database, databaseUrl!);
  });
  afterAll(async () => {
    await store?.close();
    await database?.close();
    await admin!.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await cleanupTestProductionRoles(databaseUrl!);
    await admin?.end();
  });

  it("creates one active capability and resolves only its digest", async () => {
    const invoiceId = await seedIssuedInvoice(database);
    const checkoutId = randomUUID();
    const digest = "a".repeat(64);
    const checkout = await store.create({
      organizationId,
      actorId: "merchant",
      invoiceId,
      checkoutId,
      publicNonce: Buffer.alloc(32, 1),
      derivationKeyId: "key-v1",
      tokenDigest: digest,
      now: new Date("2026-08-12T12:00:00.000Z"),
    });
    expect(checkout).toMatchObject({ checkoutId, organizationId, invoiceId });
    await expect(
      store.create({
        organizationId,
        actorId: "merchant",
        invoiceId,
        checkoutId: randomUUID(),
        publicNonce: Buffer.alloc(32, 2),
        derivationKeyId: "key-v1",
        tokenDigest: "b".repeat(64),
        now: new Date("2026-08-12T12:00:01.000Z"),
      }),
    ).rejects.toMatchObject({ code: "checkout_already_active" });
    await expect(store.resolve(digest, "public-checkout")).resolves.toEqual(
      checkout,
    );
    await expect(
      store.resolve("c".repeat(64), "public-checkout"),
    ).resolves.toBeNull();
  });

  it("revokes both tenant row and global capability atomically", async () => {
    const invoiceId = await seedIssuedInvoice(database);
    const digest = "d".repeat(64);
    const checkout = await store.create({
      organizationId,
      actorId: "merchant",
      invoiceId,
      checkoutId: randomUUID(),
      publicNonce: Buffer.alloc(32, 3),
      derivationKeyId: "key-v1",
      tokenDigest: digest,
      now: new Date("2026-08-12T12:00:00.000Z"),
    });
    await store.revoke({
      organizationId,
      actorId: "merchant",
      checkoutId: checkout.checkoutId,
      now: new Date("2026-08-12T12:01:00.000Z"),
    });
    await expect(store.resolve(digest, "public-checkout")).resolves.toBeNull();
  });
});

async function seedIssuedInvoice(database: OrganizationDatabase) {
  const customerId = randomUUID();
  const walletId = randomUUID();
  const invoiceId = randomUUID();
  await database.transaction(
    { organizationId, actorId: "test" },
    async (sql) => {
      await sql`
        INSERT INTO customers (
          id, organization_id, display_name, metadata, created_at, updated_at
        ) VALUES (
          ${customerId}::uuid, ${organizationId}::uuid, 'Buyer', '{}', now(), now()
        )
      `;
      await sql`
        INSERT INTO merchant_wallets (
          id, organization_id, address, cluster, status, verified_at,
          created_at, updated_at
        ) VALUES (
          ${walletId}::uuid, ${organizationId}::uuid,
          '11111111111111111111111111111111', 'mainnet-beta', 'active', now(),
          now(), now()
        )
      `;
      await sql`
        INSERT INTO merchant_invoices (
          id, organization_id, public_reference, customer_id,
          settlement_wallet_id, accepted_asset_symbols, currency, status,
          subtotal_minor_units, tax_minor_units, total_minor_units, due_at,
          version, issued_at, created_at, updated_at
        ) VALUES (
          ${invoiceId}::uuid, ${organizationId}::uuid, 'INV-CHECKOUT',
          ${customerId}::uuid, ${walletId}::uuid, ARRAY['USDC']::text[], 'USD',
          'issued', 100, 0, 100, '2026-08-20T00:00:00.000Z', 2,
          '2026-08-12T00:00:00.000Z', '2026-08-12T00:00:00.000Z',
          '2026-08-12T00:00:00.000Z'
        )
      `;
    },
  );
  return invoiceId;
}

function withSearchPath(urlString: string, schemaName: string): string {
  const url = new URL(urlString);
  url.searchParams.set("options", `-csearch_path=${schemaName}`);
  return url.toString();
}
