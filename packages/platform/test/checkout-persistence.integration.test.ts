import { randomUUID } from "node:crypto";
import { runMigrations as runIngestionMigrations } from "@payops/ingestion";
import { runMigrations as runReconciliationMigrations } from "@payops/reconciliation";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runPlatformMigrations } from "../src/index.js";

const baseDatabaseUrl = process.env.DATABASE_URL;
const describeDatabase = baseDatabaseUrl ? describe : describe.skip;
const schema = `payops_checkout_persistence_${process.pid}`;
const databaseUrl = baseDatabaseUrl
  ? withSearchPath(baseDatabaseUrl, schema)
  : undefined;
const admin = baseDatabaseUrl
  ? postgres(baseDatabaseUrl, { max: 1, onnotice: () => undefined })
  : undefined;
const organizationId = "00000000-0000-4000-8000-000000000001";

describeDatabase("hosted checkout persistence", () => {
  beforeAll(async () => {
    await admin!.unsafe(`CREATE SCHEMA ${schema}`);
  });

  beforeEach(async () => {
    await admin!.unsafe(`DROP SCHEMA ${schema} CASCADE`);
    await admin!.unsafe(`CREATE SCHEMA ${schema}`);
    await runIngestionMigrations(databaseUrl!);
    await runReconciliationMigrations(databaseUrl!);
    await runPlatformMigrations(databaseUrl!);
  });

  afterAll(async () => {
    await admin!.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it("stores only capability derivation material and enforces one active checkout", async () => {
    const sql = postgres(databaseUrl!, { max: 1 });
    try {
      const invoiceId = await seedIssuedInvoice(sql);
      const checkoutId = randomUUID();
      await sql`
        SELECT set_config('payops.organization_id', ${organizationId}, false)
      `;
      await sql`
        INSERT INTO public_checkouts (
          id, organization_id, invoice_id, public_nonce, derivation_key_id,
          state, version, created_at
        ) VALUES (
          ${checkoutId}::uuid, ${organizationId}::uuid, ${invoiceId}::uuid,
          ${Buffer.alloc(32, 7)}, 'checkout-key-v1', 'active', 1,
          '2026-08-12T00:00:00.000Z'
        )
      `;
      await expect(
        sql`
          INSERT INTO public_checkouts (
            id, organization_id, invoice_id, public_nonce, derivation_key_id,
            state, version, created_at
          ) VALUES (
            ${randomUUID()}::uuid, ${organizationId}::uuid, ${invoiceId}::uuid,
            ${Buffer.alloc(32, 8)}, 'checkout-key-v1', 'active', 1,
            '2026-08-12T00:00:01.000Z'
          )
        `,
      ).rejects.toMatchObject({ code: "23505" });
      const columns = await sql<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'public_checkouts'
        ORDER BY column_name
      `;
      expect(columns.map(({ column_name }) => column_name)).not.toContain(
        "token",
      );
    } finally {
      await sql.end();
    }
  });

  it("rejects invalid economic rows, cross-organization roots, and quote mutation", async () => {
    const sql = postgres(databaseUrl!, { max: 1 });
    try {
      const invoiceId = await seedIssuedInvoice(sql);
      const checkoutId = randomUUID();
      const observationId = randomUUID();
      const attemptId = randomUUID();
      const quoteId = randomUUID();
      await sql`
        SELECT set_config('payops.organization_id', ${organizationId}, false)
      `;
      await sql`
        INSERT INTO public_checkouts (
          id, organization_id, invoice_id, public_nonce, derivation_key_id,
          state, version, created_at
        ) VALUES (
          ${checkoutId}::uuid, ${organizationId}::uuid, ${invoiceId}::uuid,
          ${Buffer.alloc(32, 9)}, 'checkout-key-v1', 'active', 1,
          '2026-08-12T00:00:00.000Z'
        )
      `;
      await expect(
        sql`
          INSERT INTO quote_rate_observations (
            id, organization_id, observation_kind, source, symbol, price,
            confidence, exponent, publish_time, received_at,
            raw_response_digest
          ) VALUES (
            ${randomUUID()}::uuid, ${organizationId}::uuid, 'stablecoin',
            'pyth_hermes', 'SOL', '1', '0.001', -8,
            '2026-08-12T00:00:00.000Z', '2026-08-12T00:00:01.000Z',
            ${"d".repeat(64)}
          )
        `,
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        sql`
          INSERT INTO quote_rate_observations (
            id, organization_id, observation_kind, source, symbol, price,
            confidence, exponent, publish_time, received_at,
            raw_response_digest
          ) VALUES (
            ${randomUUID()}::uuid, ${organizationId}::uuid, 'stablecoin',
            'pyth_hermes', 'USDC', '1e0', '0.001', -8,
            '2026-08-12T00:00:00.000Z', '2026-08-12T00:00:01.000Z',
            ${"e".repeat(64)}
          )
        `,
      ).rejects.toMatchObject({ code: "23514" });
      await sql`
        INSERT INTO quote_rate_observations (
          id, organization_id, observation_kind, source, symbol, price,
          confidence, exponent, publish_time, received_at, feed_id,
          raw_response_digest
        ) VALUES (
          ${observationId}::uuid, ${organizationId}::uuid, 'stablecoin',
          'pyth_hermes', 'USDC', '1.0001', '0.0001', -8,
          '2026-08-12T00:00:00.000Z', '2026-08-12T00:00:01.000Z',
          'feed-usdc', ${"f".repeat(64)}
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
          '11111111111111111111111111111111',
          '11111111111111111111111111111111',
          'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          '11111111111111111111111111111111', 'awaiting_payment', 1,
          '2026-08-12T00:00:01.000Z', '2026-08-12T00:00:01.000Z'
        )
      `;
      await sql`
        INSERT INTO payment_quotes (
          id, organization_id, attempt_id, stablecoin_observation_id,
          formula_version, invoice_currency, invoice_minor_units,
          fiat_amount, usd_amount, stablecoin_usd_price, token_amount,
          amount_base_units, amount_tokens, input_digest, issued_at,
          expires_at, issuance_slot
        ) VALUES (
          ${quoteId}::uuid, ${organizationId}::uuid, ${attemptId}::uuid,
          ${observationId}::uuid, 'quote-v1', 'USD', 100, '1', '1',
          '1.0001', '0.9999000099990001', 999901, '0.999901',
          ${"1".repeat(64)}, '2026-08-12T00:00:01.000Z',
          '2026-08-12T00:15:01.000Z', 123456
        )
      `;
      await expect(
        sql`UPDATE payment_quotes SET amount_base_units = 1 WHERE id = ${quoteId}::uuid`,
      ).rejects.toMatchObject({ code: "23514" });

      const otherOrganizationId = randomUUID();
      await sql`
        INSERT INTO organization (id, name, slug, created_at, metadata)
        VALUES (${otherOrganizationId}::uuid, 'Other', ${`other-${otherOrganizationId}`}, now(), '{}')
      `;
      await expect(
        sql`
          INSERT INTO payment_attempts (
            id, public_attempt_id, organization_id, invoice_id, checkout_id,
            asset_symbol, reference_address, recipient_address, mint,
            recipient_token_account, state, version, created_at, updated_at
          ) VALUES (
            ${randomUUID()}::uuid, ${randomUUID()}::uuid,
            ${otherOrganizationId}::uuid, ${invoiceId}::uuid,
            ${checkoutId}::uuid, 'USDC', ${randomUUID()}, ${randomUUID()},
            ${randomUUID()}, ${randomUUID()}, 'awaiting_payment', 1, now(), now()
          )
        `,
      ).rejects.toBeDefined();
    } finally {
      await sql.end();
    }
  });
});

async function seedIssuedInvoice(sql: postgres.Sql): Promise<string> {
  const actorId = randomUUID();
  const customerId = randomUUID();
  const walletId = randomUUID();
  const invoiceId = randomUUID();
  await sql`
    SELECT set_config('payops.organization_id', ${organizationId}, false),
      set_config('payops.actor_id', ${actorId}, false)
  `;
  await sql`
    INSERT INTO customers (
      id, organization_id, display_name, metadata, created_at, updated_at
    ) VALUES (
      ${customerId}::uuid, ${organizationId}::uuid, 'Checkout Buyer', '{}',
      now(), now()
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
      ${invoiceId}::uuid, ${organizationId}::uuid, ${`INV-${invoiceId}`},
      ${customerId}::uuid, ${walletId}::uuid, ARRAY['USDC', 'USDT']::text[],
      'USD', 'issued', 100, 0, 100, '2026-08-20T00:00:00.000Z', 2,
      '2026-08-12T00:00:00.000Z', '2026-08-12T00:00:00.000Z',
      '2026-08-12T00:00:00.000Z'
    )
  `;
  return invoiceId;
}

function withSearchPath(urlString: string, schemaName: string): string {
  const url = new URL(urlString);
  url.searchParams.set("options", `-csearch_path=${schemaName}`);
  return url.toString();
}
