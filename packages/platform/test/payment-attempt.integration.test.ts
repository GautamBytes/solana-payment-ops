import { randomUUID } from "node:crypto";
import { generateKeyPairSigner } from "@solana/kit";
import { parseURL } from "@solana/pay";
import { runMigrations as runIngestionMigrations } from "@payops/ingestion";
import { runMigrations as runReconciliationMigrations } from "@payops/reconciliation";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  CheckoutStore,
  InvoiceStore,
  OrganizationDatabase,
  PaymentAttemptService,
  runPlatformMigrations,
  type StablecoinObservation,
} from "../src/index.js";

const baseDatabaseUrl = process.env.DATABASE_URL;
const describeDatabase = baseDatabaseUrl ? describe : describe.skip;
const schema = `payops_payment_attempt_${process.pid}`;
const databaseUrl = baseDatabaseUrl
  ? withSearchPath(baseDatabaseUrl, schema)
  : undefined;
const admin = baseDatabaseUrl
  ? postgres(baseDatabaseUrl, { max: 1, onnotice: () => undefined })
  : undefined;
const organizationId = "00000000-0000-4000-8000-000000000001";

describeDatabase("hosted payment attempt", () => {
  let database: OrganizationDatabase;
  let checkoutStore: CheckoutStore;

  beforeAll(async () => {
    await admin!.unsafe(`CREATE SCHEMA ${schema}`);
  });
  beforeEach(async () => {
    await checkoutStore?.close();
    await database?.close();
    await admin!.unsafe(`DROP SCHEMA ${schema} CASCADE`);
    await admin!.unsafe(`CREATE SCHEMA ${schema}`);
    await runIngestionMigrations(databaseUrl!);
    await runReconciliationMigrations(databaseUrl!);
    await runPlatformMigrations(databaseUrl!);
    database = new OrganizationDatabase(databaseUrl!, { max: 1 });
    checkoutStore = new CheckoutStore(database, databaseUrl!);
  });
  afterAll(async () => {
    await checkoutStore?.close();
    await database?.close();
    await admin!.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it("creates an exact Solana Pay request and every matching root atomically", async () => {
    const roots = await seedCheckout(database, checkoutStore);
    const service = paymentService(database, "provider-mainnet");
    const attempt = await service.create({
      organizationId,
      actorId: "checkout-payer",
      checkoutId: roots.checkoutId,
      assetSymbol: "USDC",
      idempotencyKey: "checkout-attempt-0000000000000001",
      now: new Date("2026-08-12T12:00:00.000Z"),
      signal: new AbortController().signal,
    });

    expect(attempt.amountBaseUnits).toBe("999901");
    expect(attempt.amountTokens).toBe("0.999901");
    expect(attempt.status).toBe("awaiting_payment");
    const url = new URL(attempt.paymentUrl);
    expect(url.searchParams.get("amount")).toBe("0.999901");
    expect(url.searchParams.getAll("reference")).toEqual([attempt.reference]);
    expect(url.searchParams.get("spl-token")).toBe(
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    );
    expect(url.searchParams.get("message")).toBe("Invoice INV-PAYMENT");
    const independentlyParsed = parseURL(url);
    expect("recipient" in independentlyParsed).toBe(true);
    if (!("recipient" in independentlyParsed)) throw new Error("not transfer");
    expect(String(independentlyParsed.recipient)).toBe(roots.walletAddress);
    expect(independentlyParsed.reference?.map(String)).toEqual([
      attempt.reference,
    ]);
    expect(String(independentlyParsed.splToken)).toBe(
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    );

    const evidence = await database.transaction(
      { organizationId, actorId: "test" },
      async (sql) => ({
        attempts: await count(sql, "payment_attempts"),
        quotes: await count(sql, "payment_quotes"),
        expectations: await count(sql, "hosted_payment_expectations"),
        projections: await count(sql, "payment_projections"),
        referenceWatches: Number(
          (
            await sql<{ count: string }[]>`
              SELECT count(*)::text AS count FROM watch_targets
              WHERE address = ${attempt.reference} AND active
            `
          )[0]!.count,
        ),
      }),
    );
    expect(evidence).toEqual({
      attempts: 1,
      quotes: 1,
      expectations: 1,
      projections: 1,
      referenceWatches: 1,
    });
  });

  it("replays the same attempt for the same idempotency key without new evidence", async () => {
    const roots = await seedCheckout(database, checkoutStore);
    const service = paymentService(database, "provider-mainnet");
    const input = {
      organizationId,
      actorId: "checkout-payer",
      checkoutId: roots.checkoutId,
      assetSymbol: "USDC" as const,
      idempotencyKey: "checkout-attempt-0000000000000001",
      now: new Date("2026-08-12T12:00:00.000Z"),
      signal: new AbortController().signal,
    };

    const first = await service.create(input);
    const replay = await service.create({
      ...input,
      now: new Date("2026-08-12T12:01:00.000Z"),
    });

    expect(replay).toEqual(first);
    await expect(
      database.transaction(
        { organizationId, actorId: "test" },
        async (sql) => ({
          attempts: await count(sql, "payment_attempts"),
          quotes: await count(sql, "payment_quotes"),
          expectations: await count(sql, "hosted_payment_expectations"),
        }),
      ),
    ).resolves.toEqual({ attempts: 1, quotes: 1, expectations: 1 });
  });

  it("fails closed when the configured ingestion provider is inactive", async () => {
    const roots = await seedCheckout(database, checkoutStore);
    await database.transaction(
      { organizationId, actorId: "test" },
      (sql) => sql`UPDATE rpc_providers SET active = false`,
    );

    await expect(
      paymentService(database, "provider-mainnet").create({
        organizationId,
        actorId: "checkout-payer",
        checkoutId: roots.checkoutId,
        assetSymbol: "USDC",
        idempotencyKey: "checkout-attempt-0000000000000001",
        now: new Date("2026-08-12T12:00:00.000Z"),
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "payment_attempt_unavailable" });
  });

  it("rolls back attempt, quote, observation, expectation, and projection when watch creation fails", async () => {
    const roots = await seedCheckout(database, checkoutStore);
    const service = paymentService(database, "missing-provider");
    await expect(
      service.create({
        organizationId,
        actorId: "checkout-payer",
        checkoutId: roots.checkoutId,
        assetSymbol: "USDC",
        idempotencyKey: "checkout-attempt-0000000000000001",
        now: new Date("2026-08-12T12:00:00.000Z"),
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "payment_attempt_unavailable" });
    const counts = await database.transaction(
      { organizationId, actorId: "test" },
      async (sql) => ({
        attempts: await count(sql, "payment_attempts"),
        observations: await count(sql, "quote_rate_observations"),
        quotes: await count(sql, "payment_quotes"),
        expectations: await count(sql, "hosted_payment_expectations"),
        projections: await count(sql, "payment_projections"),
      }),
    );
    expect(counts).toEqual({
      attempts: 0,
      observations: 0,
      quotes: 0,
      expectations: 0,
      projections: 0,
    });
  });

  it("blocks cancellation during an active attempt and permits it after expiry", async () => {
    const roots = await seedCheckout(database, checkoutStore);
    await paymentService(database, "provider-mainnet").create({
      organizationId,
      actorId: "checkout-payer",
      checkoutId: roots.checkoutId,
      assetSymbol: "USDC",
      idempotencyKey: "checkout-attempt-0000000000000001",
      now: new Date("2026-08-12T12:00:00.000Z"),
      signal: new AbortController().signal,
    });
    const invoices = new InvoiceStore(database);
    const cancellation = {
      organizationId,
      actorKind: "api_key" as const,
      actorId: "merchant",
      invoiceId: roots.invoiceId,
      reasonCode: "customer_request",
      now: new Date("2026-08-12T12:20:00.000Z"),
    };
    await expect(invoices.cancel(cancellation)).rejects.toMatchObject({
      code: "invoice_has_payment",
    });
    await database.transaction(
      { organizationId, actorId: "test" },
      async (sql) => {
        await sql`
          UPDATE payment_attempts SET state = 'expired', version = version + 1
          WHERE organization_id = ${organizationId}::uuid
            AND checkout_id = ${roots.checkoutId}::uuid
        `;
        await sql`
          UPDATE hosted_payment_expectations SET
            active = false, deactivated_at = ${cancellation.now.toISOString()}
          WHERE organization_id = ${organizationId}::uuid
            AND invoice_id = ${roots.invoiceId}::uuid
        `;
      },
    );
    await expect(invoices.cancel(cancellation)).resolves.toMatchObject({
      id: roots.invoiceId,
      status: "cancelled",
    });
  });
});

function paymentService(database: OrganizationDatabase, providerId: string) {
  return new PaymentAttemptService({
    database,
    providerId,
    environment: "production",
    stablecoinPrices: {
      observe: async () => stablecoinObservation(),
    },
    quoteHead: {
      getFinalizedHead: async () => ({ slot: 123_456n, signature: null }),
    },
  });
}

async function seedCheckout(
  database: OrganizationDatabase,
  checkoutStore: CheckoutStore,
) {
  const customerId = randomUUID();
  const walletId = randomUUID();
  const invoiceId = randomUUID();
  const checkoutId = randomUUID();
  const wallet = await generateKeyPairSigner();
  const tokenAccount = await generateKeyPairSigner();
  await database.transaction(
    { organizationId, actorId: "test" },
    async (sql) => {
      await sql`
        INSERT INTO rpc_providers (
          id, cluster, endpoint_env, endpoint_label, active, created_at
        ) VALUES (
          'provider-mainnet', 'mainnet-beta', 'TEST_RPC_URL', 'test', true, now()
        )
      `;
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
          ${walletId}::uuid, ${organizationId}::uuid, ${wallet.address},
          'mainnet-beta', 'active', now(), now(), now()
        )
      `;
      await sql`
        INSERT INTO merchant_wallet_assets (
          organization_id, wallet_id, symbol, mint, token_account, decimals,
          token_program, created_at
        ) VALUES (
          ${organizationId}::uuid, ${walletId}::uuid, 'USDC',
          'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', ${tokenAccount.address},
          6, 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', now()
        )
      `;
      await sql`
        INSERT INTO watch_targets (
          id, provider_id, cluster, address, cutover_slot, cutover_signature,
          overlap_slots, committed_head_slot, committed_head_signature,
          coverage, active, created_at, organization_id
        ) VALUES (
          ${`merchant-wallet:${walletId}:USDC`}, 'provider-mainnet',
          'mainnet-beta', ${tokenAccount.address}, 123456, null, 64, 123456,
          null, 'complete', true, now(), ${organizationId}::uuid
        )
      `;
      await sql`
        INSERT INTO merchant_invoices (
          id, organization_id, public_reference, customer_id,
          settlement_wallet_id, accepted_asset_symbols, currency, status,
          subtotal_minor_units, tax_minor_units, total_minor_units, due_at,
          version, issued_at, created_at, updated_at
        ) VALUES (
          ${invoiceId}::uuid, ${organizationId}::uuid, 'INV-PAYMENT',
          ${customerId}::uuid, ${walletId}::uuid, ARRAY['USDC']::text[], 'USD',
          'issued', 100, 0, 100, '2026-08-20T00:00:00.000Z', 2,
          '2026-08-12T00:00:00.000Z', '2026-08-12T00:00:00.000Z',
          '2026-08-12T00:00:00.000Z'
        )
      `;
    },
  );
  await checkoutStore.create({
    organizationId,
    actorId: "merchant",
    invoiceId,
    checkoutId,
    publicNonce: Buffer.alloc(32, 1),
    derivationKeyId: "key-v1",
    tokenDigest: "a".repeat(64),
    now: new Date("2026-08-12T00:00:00.000Z"),
  });
  return { invoiceId, checkoutId, walletAddress: String(wallet.address) };
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

async function count(
  sql: postgres.TransactionSql,
  table: string,
): Promise<number> {
  const rows = await sql.unsafe<{ count: string }[]>(
    `SELECT count(*)::text AS count FROM ${table}`,
  );
  return Number(rows[0]!.count);
}

function withSearchPath(urlString: string, schemaName: string): string {
  const url = new URL(urlString);
  url.searchParams.set("options", `-csearch_path=${schemaName}`);
  return url.toString();
}
