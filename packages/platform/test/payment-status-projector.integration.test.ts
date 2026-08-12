import { randomUUID } from "node:crypto";
import { generateKeyPairSigner } from "@solana/kit";
import { runMigrations as runIngestionMigrations } from "@payops/ingestion";
import { runMigrations as runReconciliationMigrations } from "@payops/reconciliation";
import { parseLifecycleEventEnvelope } from "@payops/webhooks";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  CheckoutStore,
  InvoiceStore,
  OrganizationDatabase,
  PaymentAttemptService,
  PaymentStatusProjector,
  QuoteExpiryService,
  runPlatformMigrations,
  type StablecoinObservation,
} from "../src/index.js";

const baseDatabaseUrl = process.env.DATABASE_URL;
const describeDatabase = baseDatabaseUrl ? describe : describe.skip;
const schema = `payops_payment_projection_${process.pid}`;
const databaseUrl = baseDatabaseUrl
  ? withSearchPath(baseDatabaseUrl, schema)
  : undefined;
const admin = baseDatabaseUrl
  ? postgres(baseDatabaseUrl, { max: 1, onnotice: () => undefined })
  : undefined;
const organizationId = "00000000-0000-4000-8000-000000000001";
const alternateSignature =
  "2Ana1pUpv2ZbMVkwF5FXapYeBEjdxDatLn7nvJkhgTSXbs59SyZSx866bXirPgj8QQVB57uxHJBG1YFvkRbFj4T";

describeDatabase("hosted payment status projection", () => {
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
    database = new OrganizationDatabase(databaseUrl!, { max: 2 });
    checkoutStore = new CheckoutStore(database, databaseUrl!);
  });

  afterAll(async () => {
    await checkoutStore?.close();
    await database?.close();
    await admin!.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it("projects detected, confirmed, finalized, and paid exactly once", async () => {
    const fixture = await seedAttempt(database, checkoutStore);
    await seedChainEvent(database, fixture, "detected", "999901");
    const projector = new PaymentStatusProjector(database);

    await expect(project(projector)).resolves.toMatchObject({
      outcome: "changed",
      publicStatus: "detected",
    });
    await setChainState(database, "confirmed");
    await expect(project(projector)).resolves.toMatchObject({
      publicStatus: "confirmed",
    });
    await setChainState(database, "finalized");
    await expect(project(projector)).resolves.toMatchObject({
      publicStatus: "paid",
    });
    await expect(project(projector)).resolves.toEqual({ outcome: "not_found" });

    const checkout = await checkoutStore.getActiveForInvoice({
      organizationId,
      actorId: "merchant",
      invoiceId: fixture.invoiceId,
    });
    expect(checkout).not.toBeNull();
    const publicView = await checkoutStore.publicView(
      checkout!,
      new Date("2026-08-12T12:05:00.000Z"),
    );
    expect(publicView).toMatchObject({
      schemaVersion: "0.1",
      invoice: { publicReference: "INV-PROJECTION", status: "paid" },
      currentAttempt: {
        publicAttemptId: fixture.attempt.publicAttemptId,
        status: "paid",
      },
    });
    expect(JSON.stringify(publicView)).not.toContain(organizationId);
    expect(JSON.stringify(publicView)).not.toContain(fixture.invoiceId);

    await expect(
      new InvoiceStore(database).cancel({
        organizationId,
        actorKind: "api_key",
        actorId: "merchant",
        invoiceId: fixture.invoiceId,
        reasonCode: "customer_request",
        now: new Date("2026-08-12T12:06:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "invoice_has_payment" });

    const evidence = await inspect(database);
    expect(evidence.projection).toEqual({ public_status: "paid", version: 5 });
    expect(evidence.invoice).toEqual({ status: "paid", version: 3 });
    expect(evidence.allocations).toBe(1);
    expect(evidence.exceptions).toBe(0);
    expect(evidence.history).toEqual([
      "awaiting_payment",
      "detected",
      "confirmed",
      "finalized",
      "paid",
    ]);
    expect(evidence.events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "payment.detected",
        "payment.confirmed",
        "payment.finalized",
        "invoice.paid",
      ]),
    );
    for (const event of evidence.events) {
      expect(
        parseLifecycleEventEnvelope(JSON.parse(event.payload) as unknown),
      ).not.toBeNull();
      expect(event.payload).not.toContain("customer@example.com");
      expect(event.payload).not.toContain("checkout-token");
    }
  });

  it("creates a durable exception instead of paying a wrong amount", async () => {
    const fixture = await seedAttempt(database, checkoutStore);
    await seedChainEvent(database, fixture, "finalized", "999900");
    const result = await project(new PaymentStatusProjector(database));
    expect(result).toMatchObject({ publicStatus: "exception" });

    const evidence = await inspect(database);
    expect(evidence.invoice.status).toBe("issued");
    expect(evidence.allocations).toBe(0);
    expect(evidence.exceptions).toBe(1);
    expect(evidence.events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "payment.finalized",
        "payment.exception_created",
      ]),
    );
    expect(
      JSON.parse(
        evidence.events.find(
          (event) => event.type === "payment.exception_created",
        )!.payload,
      ) as { data: { code: string } },
    ).toMatchObject({ data: { code: "partial_payment" } });
  });

  it("fails closed when a transfer carries extra references", async () => {
    const fixture = await seedAttempt(database, checkoutStore);
    await seedChainEvent(database, fixture, "finalized", "999901");
    await database.transaction(
      { organizationId, actorId: "test" },
      async (sql) => {
        await sql`
          INSERT INTO event_references (chain_event_id, reference_address)
          SELECT id, 'attacker-added-reference' FROM chain_events
          WHERE event_id = 'hosted-event-1'
        `;
      },
    );
    await project(new PaymentStatusProjector(database));
    const evidence = await inspect(database);
    expect(evidence.invoice.status).toBe("issued");
    expect(evidence.allocations).toBe(0);
    expect(evidence.exceptions).toBe(1);
    expect(
      JSON.parse(
        evidence.events.find(
          (event) => event.type === "payment.exception_created",
        )!.payload,
      ) as { data: { code: string; invoiceId: string | null } },
    ).toMatchObject({
      data: { code: "ambiguous_reference", invoiceId: null },
    });
  });

  it("revokes only non-final confirmation and keeps the attempt reusable", async () => {
    const fixture = await seedAttempt(database, checkoutStore);
    await seedChainEvent(database, fixture, "confirmed", "999901");
    const projector = new PaymentStatusProjector(database);
    await project(projector);
    await setChainState(database, "detected");
    await expect(project(projector)).resolves.toEqual({ outcome: "unchanged" });
    await setChainState(database, "reverted");
    await expect(project(projector)).resolves.toMatchObject({
      publicStatus: "confirmation_revoked",
    });
    await expect(project(projector)).resolves.toEqual({ outcome: "unchanged" });

    const evidence = await inspect(database);
    expect(evidence.history).toEqual([
      "awaiting_payment",
      "confirmed",
      "confirmation_revoked",
    ]);
    expect(evidence.events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "payment.confirmed",
        "payment.confirmation_revoked",
      ]),
    );
  });

  it("does not let an unchanged early event starve a later status transition", async () => {
    const fixture = await seedAttempt(database, checkoutStore);
    await seedChainEvent(database, fixture, "detected", "999901", {
      eventId: "a-stable-event",
      signature: "1".repeat(64),
    });
    const projector = new PaymentStatusProjector(database);
    await projector.projectOne({
      organizationId,
      actorId: "status-worker",
      chainEventId: "a-stable-event",
      now: new Date("2026-08-12T12:04:00.000Z"),
    });
    await seedChainEvent(database, fixture, "confirmed", "999901", {
      eventId: "z-actionable-event",
      signature: alternateSignature,
    });

    await expect(
      projector.projectAvailable({
        organizationId,
        actorId: "status-worker",
        now: new Date("2026-08-12T12:05:00.000Z"),
        limit: 1,
      }),
    ).resolves.toEqual({ examined: 1, changed: 1 });
    await expect(inspect(database)).resolves.toMatchObject({
      projection: { public_status: "confirmed" },
    });
  });

  it("rolls the status transition back when transactional outbox enqueue fails", async () => {
    const fixture = await seedAttempt(database, checkoutStore);
    await seedChainEvent(database, fixture, "detected", "999901");
    await database.transaction(
      { organizationId, actorId: "test" },
      async (sql) => {
        await sql.unsafe(`
          CREATE FUNCTION payops_test_fail_webhook() RETURNS trigger
          LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced outbox failure'; END $$;
          CREATE TRIGGER payops_test_fail_webhook
          BEFORE INSERT ON webhook_events
          FOR EACH ROW EXECUTE FUNCTION payops_test_fail_webhook();
        `);
      },
    );
    await expect(project(new PaymentStatusProjector(database))).rejects.toThrow(
      "forced outbox failure",
    );
    const evidence = await inspect(database);
    expect(evidence.projection).toEqual({
      public_status: "awaiting_payment",
      version: 1,
    });
    expect(evidence.history).toEqual(["awaiting_payment"]);
    expect(evidence.events).toEqual([]);
  });

  it("expires an unpaid quote while retaining its reference for late-payment review", async () => {
    const fixture = await seedAttempt(database, checkoutStore);
    const expiry = new QuoteExpiryService(database);
    await expect(
      expiry.expireAvailable({
        organizationId,
        actorId: "expiry-worker",
        now: new Date("2026-08-12T12:15:00.000Z"),
      }),
    ).resolves.toEqual({ expired: 1 });
    await expect(
      expiry.expireAvailable({
        organizationId,
        actorId: "expiry-worker",
        now: new Date("2026-08-12T12:16:00.000Z"),
      }),
    ).resolves.toEqual({ expired: 0 });
    const retained = await database.transaction(
      { organizationId, actorId: "test" },
      async (sql) => {
        const [row] = await sql<
          {
            status: string;
            expectation_active: boolean;
            watch_active: boolean;
          }[]
        >`
          SELECT projection.public_status AS status,
            expectation.active AS expectation_active, watch.active AS watch_active
          FROM payment_projections AS projection
          JOIN hosted_payment_expectations AS expectation
            ON expectation.attempt_id = projection.attempt_id
            AND expectation.organization_id = projection.organization_id
          JOIN watch_targets AS watch
            ON watch.organization_id = expectation.organization_id
            AND watch.address = expectation.reference_address
          WHERE projection.organization_id = ${organizationId}::uuid
        `;
        return row!;
      },
    );
    expect(retained).toEqual({
      status: "expired",
      expectation_active: true,
      watch_active: true,
    });
    expect(fixture.attempt.reference).toBeTruthy();
  });
});

async function project(projector: PaymentStatusProjector) {
  return projector.projectOne({
    organizationId,
    actorId: "status-worker",
    chainEventId: "hosted-event-1",
    now: new Date("2026-08-12T12:05:00.000Z"),
  });
}

async function seedAttempt(
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
          id, organization_id, display_name, email, metadata, created_at, updated_at
        ) VALUES (
          ${customerId}::uuid, ${organizationId}::uuid, 'Buyer',
          'customer@example.com', '{}', now(), now()
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
          id, provider_id, cluster, address, cutover_slot, overlap_slots,
          committed_head_slot, coverage, active, created_at, organization_id
        ) VALUES (
          ${`merchant-wallet:${walletId}:USDC`}, 'provider-mainnet',
          'mainnet-beta', ${tokenAccount.address}, 123456, 64, 123456,
          'complete', true, now(), ${organizationId}::uuid
        )
      `;
      await sql`
        INSERT INTO merchant_invoices (
          id, organization_id, public_reference, customer_id,
          settlement_wallet_id, accepted_asset_symbols, currency, status,
          subtotal_minor_units, tax_minor_units, total_minor_units, due_at,
          version, issued_at, created_at, updated_at
        ) VALUES (
          ${invoiceId}::uuid, ${organizationId}::uuid, 'INV-PROJECTION',
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
  const attempt = await new PaymentAttemptService({
    database,
    providerId: "provider-mainnet",
    environment: "production",
    stablecoinPrices: { observe: async () => stablecoinObservation() },
    quoteHead: {
      getFinalizedHead: async () => ({ slot: 123_456n, signature: null }),
    },
  }).create({
    organizationId,
    actorId: "checkout-payer",
    checkoutId,
    assetSymbol: "USDC",
    idempotencyKey: "projector-attempt-0000000000000001",
    now: new Date("2026-08-12T12:00:00.000Z"),
    signal: new AbortController().signal,
  });
  return {
    invoiceId,
    checkoutId,
    tokenAccount: String(tokenAccount.address),
    attempt,
  };
}

async function seedChainEvent(
  database: OrganizationDatabase,
  fixture: Awaited<ReturnType<typeof seedAttempt>>,
  state: "detected" | "confirmed" | "finalized",
  amountBaseUnits: string,
  identity: {
    readonly eventId: string;
    readonly signature: string;
  } = { eventId: "hosted-event-1", signature: "1".repeat(64) },
) {
  await database.transaction(
    { organizationId, actorId: "test" },
    async (sql) => {
      const raw = await sql<{ id: string }[]>`
        INSERT INTO raw_transactions (
          provider_id, signature, commitment, digest, canonical_body, body,
          byte_length, retrieved_at
        ) VALUES (
          'provider-mainnet', ${identity.signature}, 'confirmed',
          ${identity.signature === "1".repeat(64) ? "d".repeat(64) : "e".repeat(64)},
          '{"blockTime":1786536030}', '{"blockTime":1786536030}'::jsonb,
          24, '2026-08-12T12:00:30.000Z'
        ) RETURNING id::text
      `;
      const event = await sql<{ id: string }[]>`
        INSERT INTO chain_events (
          event_id, cluster, signature, outer_instruction_index,
          inner_instruction_index, raw_transaction_id, current_state
        ) VALUES (
          ${identity.eventId}, 'mainnet-beta', ${identity.signature}, 2, -1,
          ${raw[0]!.id}::bigint, ${state}
        ) RETURNING id::text
      `;
      await sql`
        INSERT INTO normalized_transfers (
          chain_event_id, parser_version, program_id, source_token_account,
          source_account_index, mint, destination_token_account,
          destination_account_index, authority, amount_base_units, decimals
        ) VALUES (
          ${event[0]!.id}::bigint, '1.0.0',
          'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
          ${fixture.tokenAccount}, 1,
          'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          ${fixture.tokenAccount}, 2, ${fixture.tokenAccount},
          ${amountBaseUnits}, 6
        )
      `;
      await sql`
        INSERT INTO event_references (chain_event_id, reference_address)
        VALUES (${event[0]!.id}::bigint, ${fixture.attempt.reference})
      `;
    },
  );
}

async function setChainState(database: OrganizationDatabase, state: string) {
  await database.transaction(
    { organizationId, actorId: "test" },
    async (sql) => {
      await sql`
        UPDATE chain_events SET current_state = ${state}
        WHERE event_id = 'hosted-event-1'
      `;
    },
  );
}

async function inspect(database: OrganizationDatabase) {
  return database.transaction(
    { organizationId, actorId: "test" },
    async (sql) => {
      const [projection] = await sql<
        { public_status: string; version: number }[]
      >`SELECT public_status, version FROM payment_projections`;
      const [invoice] = await sql<{ status: string; version: number }[]>`
        SELECT status, version FROM merchant_invoices
      `;
      const history = await sql<{ to_status: string }[]>`
        SELECT to_status FROM payment_status_history ORDER BY source_version
      `;
      const events = await sql<{ type: string; payload: string }[]>`
        SELECT event_type AS type, payload FROM webhook_events ORDER BY created_at, id
      `;
      const [allocationCount] = await sql<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM hosted_payment_allocations
      `;
      const [exceptionCount] = await sql<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM hosted_payment_exceptions
      `;
      return {
        projection: projection!,
        invoice: invoice!,
        history: history.map((row) => row.to_status),
        events,
        allocations: allocationCount!.count,
        exceptions: exceptionCount!.count,
      };
    },
  );
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
