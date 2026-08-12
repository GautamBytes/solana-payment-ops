import { randomUUID } from "node:crypto";
import { runMigrations as runIngestionMigrations } from "@payops/ingestion";
import { runMigrations as runReconciliationMigrations } from "@payops/reconciliation";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  OrganizationDatabase,
  QuoteStore,
  QuoteStoreError,
  runPlatformMigrations,
  type StablecoinObservation,
} from "../src/index.js";

const baseDatabaseUrl = process.env.DATABASE_URL;
const describeDatabase = baseDatabaseUrl ? describe : describe.skip;
const schema = `payops_quote_store_${process.pid}`;
const databaseUrl = baseDatabaseUrl
  ? withSearchPath(baseDatabaseUrl, schema)
  : undefined;
const admin = baseDatabaseUrl
  ? postgres(baseDatabaseUrl, { max: 1, onnotice: () => undefined })
  : undefined;
const organizationId = "00000000-0000-4000-8000-000000000001";

describeDatabase("reproducible quote store", () => {
  let database: OrganizationDatabase;
  let store: QuoteStore;

  beforeAll(async () => {
    await admin!.unsafe(`CREATE SCHEMA ${schema}`);
  });

  beforeEach(async () => {
    await database?.close();
    await admin!.unsafe(`DROP SCHEMA ${schema} CASCADE`);
    await admin!.unsafe(`CREATE SCHEMA ${schema}`);
    await runIngestionMigrations(databaseUrl!);
    await runReconciliationMigrations(databaseUrl!);
    await runPlatformMigrations(databaseUrl!);
    database = new OrganizationDatabase(databaseUrl!, { max: 1 });
    store = new QuoteStore(database);
  });

  afterAll(async () => {
    await database?.close();
    await admin!.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it("locks canonical invoice economics and persists reproducible observations and quote atomically", async () => {
    const roots = await seedAttempt(database);
    const result = await store.create({
      organizationId,
      actorId: "quote-worker",
      attemptId: roots.attemptId,
      stablecoinObservation: stablecoinObservation(),
      issuedAt: new Date("2026-08-12T12:00:00.000Z"),
      issuanceSlot: "123456",
    });
    expect(result.quote.invoiceMinorUnits).toBe("100");
    expect(result.quote.amountBaseUnits).toBe("999901");
    expect(result.quote.amountTokens).toBe("0.999901");
    await expect(
      store.get({
        organizationId,
        actorId: "quote-worker",
        attemptId: roots.attemptId,
      }),
    ).resolves.toEqual(result);
    const counts = await database.transaction(
      { organizationId, actorId: "test" },
      async (sql) => ({
        observations: Number(
          (
            await sql<{ count: string }[]>`
              SELECT count(*)::text AS count FROM quote_rate_observations
            `
          )[0]!.count,
        ),
        quotes: Number(
          (
            await sql<{ count: string }[]>`
              SELECT count(*)::text AS count FROM payment_quotes
            `
          )[0]!.count,
        ),
      }),
    );
    expect(counts).toEqual({ observations: 1, quotes: 1 });
  });

  it("rejects stale caller economics and rolls back every write", async () => {
    const roots = await seedAttempt(database);
    await expect(
      store.create({
        organizationId,
        actorId: "quote-worker",
        attemptId: roots.attemptId,
        expectedInvoiceMinorUnits: "101",
        stablecoinObservation: stablecoinObservation(),
        issuedAt: new Date("2026-08-12T12:00:00.000Z"),
        issuanceSlot: "123456",
      }),
    ).rejects.toMatchObject({
      code: "quote_invoice_changed",
    } satisfies Partial<QuoteStoreError>);
    const count = await database.transaction(
      { organizationId, actorId: "test" },
      async (sql) =>
        Number(
          (
            await sql<{ count: string }[]>`
              SELECT count(*)::text AS count FROM quote_rate_observations
            `
          )[0]!.count,
        ),
    );
    expect(count).toBe(0);
  });
});

async function seedAttempt(database: OrganizationDatabase) {
  const customerId = randomUUID();
  const walletId = randomUUID();
  const invoiceId = randomUUID();
  const checkoutId = randomUUID();
  const attemptId = randomUUID();
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
          ${invoiceId}::uuid, ${organizationId}::uuid, 'INV-QUOTE',
          ${customerId}::uuid, ${walletId}::uuid, ARRAY['USDC']::text[], 'USD',
          'issued', 100, 0, 100, '2026-08-20T00:00:00.000Z', 2,
          '2026-08-12T00:00:00.000Z', '2026-08-12T00:00:00.000Z',
          '2026-08-12T00:00:00.000Z'
        )
      `;
      await sql`
        INSERT INTO public_checkouts (
          id, organization_id, invoice_id, public_nonce, derivation_key_id,
          state, version, created_at
        ) VALUES (
          ${checkoutId}::uuid, ${organizationId}::uuid, ${invoiceId}::uuid,
          ${Buffer.alloc(32, 1)}, 'checkout-key-v1', 'active', 1,
          '2026-08-12T00:00:00.000Z'
        )
      `;
      await sql`
        INSERT INTO payment_attempts (
          id, public_attempt_id, organization_id, invoice_id, checkout_id,
          asset_symbol, reference_address, recipient_address, mint,
          recipient_token_account, state, version, created_at, updated_at
        ) VALUES (
          ${attemptId}::uuid, ${randomUUID()}::uuid, ${organizationId}::uuid,
          ${invoiceId}::uuid, ${checkoutId}::uuid, 'USDC',
          '11111111111111111111111111111112',
          '11111111111111111111111111111111',
          'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          '11111111111111111111111111111111', 'created', 1,
          '2026-08-12T12:00:00.000Z', '2026-08-12T12:00:00.000Z'
        )
      `;
    },
  );
  return { invoiceId, checkoutId, attemptId };
}

function stablecoinObservation(): StablecoinObservation {
  return {
    source: "pyth_hermes",
    symbol: "USDC",
    price: "1.0001",
    confidence: "0.0001",
    exponent: -8,
    publishTime: "2026-08-12T11:59:45.000Z",
    feedId: "b".repeat(64),
    receivedAt: "2026-08-12T12:00:00.000Z",
    rawResponseDigest: "c".repeat(64),
  };
}

function withSearchPath(urlString: string, schemaName: string): string {
  const url = new URL(urlString);
  url.searchParams.set("options", `-csearch_path=${schemaName}`);
  return url.toString();
}
