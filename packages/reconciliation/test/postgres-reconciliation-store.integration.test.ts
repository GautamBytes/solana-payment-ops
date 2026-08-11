import { runMigrations as runIngestionMigrations } from "@payops/ingestion";
import { parseLifecycleEventEnvelope } from "@payops/webhooks";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  PostgresReconciliationStore,
  ReconciliationError,
  reconcileEvent,
  runMigrations,
  type InvoiceImport,
  type ReconciliationDecision,
} from "../src/index.js";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://payops:payops@127.0.0.1:55432/payops_test";
const sql = postgres(databaseUrl, { max: 1 });
let store: PostgresReconciliationStore;

const invoice: InvoiceImport = {
  invoiceId: "inv-001",
  customerId: "customer-001",
  expectedMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  destinationTokenAccount: "Cmn8RVNLZAtyq51B31RXDrrS24DYphEftzDCX4FzPLM",
  amountBaseUnits: 12_500_000n,
  referenceAddress: "Gh5GixNvrU87vKWcLLLp6dcgBGRDtP4EJesFu6rjif4",
  issuedAt: new Date("2026-08-01T00:00:00.000Z"),
  dueAt: new Date("2026-08-15T00:00:00.000Z"),
};

const unrelatedInvoice: InvoiceImport = {
  ...invoice,
  invoiceId: "inv-002",
  customerId: "customer-002",
  referenceAddress: "2Pg5gJ2nWw7M7J6rt8QZf5PfeJ6e6xNnYmkbB6JwYb3a",
};
const astral = "\u{1F680}";

async function seedFinalizedEvent(
  overrides: {
    readonly mint?: string;
    readonly amountBaseUnits?: bigint;
  } = {},
): Promise<void> {
  await sql`
    INSERT INTO rpc_providers (id, cluster, endpoint_env, endpoint_label)
    VALUES ('primary', 'mainnet-beta', 'SOLANA_RPC_URL', 'test')
  `;
  const raw = await sql<{ id: string }[]>`
    INSERT INTO raw_transactions (
      provider_id, signature, commitment, digest, canonical_body, body,
      byte_length, retrieved_at
    ) VALUES (
      'primary', 'signature-001', 'finalized', 'digest', '{}',
      ${sql.json({ blockTime: 1_786_320_000 })},
      2, '2026-08-10T00:00:00.000Z'
    ) RETURNING id::text
  `;
  const event = await sql<{ id: string }[]>`
    INSERT INTO chain_events (
      event_id, cluster, signature, outer_instruction_index,
      inner_instruction_index, raw_transaction_id, current_state
    ) VALUES (
      'event-001', 'mainnet-beta', 'signature-001', 0, -1,
      ${raw[0]?.id ?? "0"}, 'finalized'
    ) RETURNING id::text
  `;
  const eventId = event[0]?.id ?? "0";
  await sql`
    INSERT INTO normalized_transfers (
      chain_event_id, parser_version, program_id, source_token_account,
      source_account_index, mint, destination_token_account,
      destination_account_index, authority, amount_base_units, decimals
    ) VALUES (
      ${eventId}, '0.2.0', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      '8rUz82MkFsfqjpVjjgWEM66Brr1sm1R7VKZ991fF41e', 1,
      ${overrides.mint ?? invoice.expectedMint}, ${invoice.destinationTokenAccount}, 2,
      '4wBqpZM9xaSheZzJSMawUKKwhdpChKbZ5eu5ky4Vigw',
      ${(overrides.amountBaseUnits ?? invoice.amountBaseUnits).toString()}, 6
    )
  `;
  await sql`
    INSERT INTO event_references (chain_event_id, reference_address)
    VALUES (${eventId}, ${invoice.referenceAddress})
  `;
}

async function insertTransferRepresentation(
  parserVersion: string,
  overrides: {
    readonly mint?: string;
    readonly amountBaseUnits?: bigint;
  } = {},
): Promise<void> {
  await sql`
    INSERT INTO normalized_transfers (
      chain_event_id, parser_version, program_id, source_token_account,
      source_account_index, mint, destination_token_account,
      destination_account_index, authority, amount_base_units, decimals
    )
    SELECT
      event.id, ${parserVersion},
      'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      '8rUz82MkFsfqjpVjjgWEM66Brr1sm1R7VKZ991fF41e', 1,
      ${overrides.mint ?? invoice.expectedMint},
      ${invoice.destinationTokenAccount}, 2,
      '4wBqpZM9xaSheZzJSMawUKKwhdpChKbZ5eu5ky4Vigw',
      ${(overrides.amountBaseUnits ?? invoice.amountBaseUnits).toString()}, 6
    FROM chain_events AS event
    WHERE event.event_id = 'event-001'
  `;
}

beforeAll(async () => {
  await runIngestionMigrations(databaseUrl);
  await runMigrations(databaseUrl);
  await runMigrations(databaseUrl);
  store = new PostgresReconciliationStore({ databaseUrl });
});

beforeEach(async () => {
  await sql.unsafe(`
    TRUNCATE TABLE
      webhook_delivery_attempts,
      webhook_deliveries,
      webhook_events,
      webhook_endpoints,
      reconciliation_exceptions,
      reconciliation_allocations,
      reconciliation_runs,
      reconciliation_invoices,
      event_references,
      normalized_transfers,
      chain_events,
      finality_observations,
      ingestion_quarantines,
      ingestion_retries,
      discovered_signatures,
      raw_transactions,
      sync_run_pages,
      sync_runs,
      watch_targets,
      rpc_providers
    RESTART IDENTITY CASCADE
  `);
});

afterAll(async () => {
  await store.close();
  await sql.end();
});

describe("PostgresReconciliationStore", () => {
  it("applies every reconciliation and webhook migration idempotently", async () => {
    const rows = await sql<{ name: string; count: number }[]>`
      SELECT name, count(*)::integer AS count
      FROM payops_schema_migrations
      WHERE name IN (
        '1001_reconciliation_pilot',
        '1002_semantic_parser_versions',
        '1003_strict_parser_versions',
        '1004_event_contract_bounds',
        '2001_transactional_webhooks'
      )
      GROUP BY name
      ORDER BY name
    `;
    expect(rows).toEqual([
      { name: "1001_reconciliation_pilot", count: 1 },
      { name: "1002_semantic_parser_versions", count: 1 },
      { name: "1003_strict_parser_versions", count: 1 },
      { name: "1004_event_contract_bounds", count: 1 },
      { name: "2001_transactional_webhooks", count: 1 },
    ]);
    await expect(
      sql<{ newer: boolean }[]>`
        SELECT payops_semver_key('0.10.0') > payops_semver_key('0.9.0') AS newer
      `,
    ).resolves.toEqual([{ newer: true }]);
    await expect(
      sql<{ newer: boolean }[]>`
        SELECT
          payops_semver_key('999999999.999999999.999999999')
            > payops_semver_key('999999999.999999999.999999998') AS newer
      `,
    ).resolves.toEqual([{ newer: true }]);
    await seedFinalizedEvent();
    await expect(
      sql`
        UPDATE normalized_transfers
        SET parser_version = '0.10.0-beta.1'
      `,
    ).rejects.toMatchObject({
      constraint_name: "normalized_transfers_parser_version_check",
    });
    await expect(
      insertTransferRepresentation("1000000000.0.0"),
    ).rejects.toMatchObject({
      constraint_name: "normalized_transfers_parser_version_check",
    });
  });

  it("imports identical invoices idempotently and rejects changed data", async () => {
    await expect(store.importInvoices([invoice], new Date())).resolves.toEqual({
      inserted: 1,
      existing: 0,
    });
    await expect(store.importInvoices([invoice], new Date())).resolves.toEqual({
      inserted: 0,
      existing: 1,
    });
    await expect(
      store.importInvoices([{ ...invoice, amountBaseUnits: 1n }], new Date()),
    ).rejects.toBeInstanceOf(ReconciliationError);
  });

  it("validates the complete invoice batch against lifecycle-event bounds", async () => {
    const boundaryInvoice = {
      ...invoice,
      invoiceId: astral.repeat(128),
      customerId: astral.repeat(512),
    };
    await expect(
      store.importInvoices([boundaryInvoice], new Date()),
    ).resolves.toEqual({ inserted: 1, existing: 0 });

    await sql`TRUNCATE reconciliation_invoices CASCADE`;
    await expect(
      store.importInvoices(
        [invoice, { ...unrelatedInvoice, invoiceId: astral.repeat(129) }],
        new Date(),
      ),
    ).rejects.toBeInstanceOf(ReconciliationError);
    await expect(store.listInvoices()).resolves.toEqual([]);

    await expect(
      store.importInvoices(
        [{ ...invoice, customerId: astral.repeat(513) }],
        new Date(),
      ),
    ).rejects.toBeInstanceOf(ReconciliationError);
    await expect(store.listInvoices()).resolves.toEqual([]);
  });

  it("reads finalized events and records an exact decision once", async () => {
    await store.importInvoices([invoice], new Date());
    await seedFinalizedEvent();
    const invoices = await store.listInvoices();
    const events = await store.listFinalizedCandidates();
    expect(events).toHaveLength(1);

    const decision = reconcileEvent(events[0]!, invoices);
    await expect(store.recordDecision(decision, new Date())).resolves.toBe(
      true,
    );
    await expect(store.recordDecision(decision, new Date())).resolves.toBe(
      false,
    );
    await expect(store.listInvoices()).resolves.toMatchObject([
      { invoiceId: "inv-001", status: "matched" },
    ]);
    await expect(store.getReportRows()).resolves.toMatchObject([
      {
        invoiceId: "inv-001",
        status: "matched",
        eventId: "event-001",
        ruleCode: "exact_match",
      },
    ]);
    await expect(
      store.getReport(new Date("2026-08-07T12:00:00.000Z")),
    ).resolves.toMatchObject({
      schemaVersion: "0.1",
      generatedAt: "2026-08-07T12:00:00.000Z",
      summary: {
        invoices: 1,
        matched: 1,
        open: 0,
        exception: 0,
        allocations: 1,
        exceptions: 0,
        unapplied: 0,
      },
      allocations: [
        {
          eventId: "event-001",
          signature: "signature-001",
          outerInstructionIndex: 0,
          innerInstructionIndex: null,
          invoiceId: "inv-001",
          ruleCode: "exact_match",
        },
      ],
      exceptions: [],
    });
  });

  it("publishes a consumer-valid event for DB-compatible astral legacy identity", async () => {
    const decidedAt = new Date("2026-08-07T12:00:00.000Z");
    const publishedInvoice = {
      ...invoice,
      invoiceId: astral.repeat(128),
      customerId: astral.repeat(512),
    };
    await sql`
      INSERT INTO reconciliation_invoices (
        invoice_id, customer_id, expected_mint, destination_token_account,
        amount_base_units, reference_address, issued_at, due_at,
        row_digest, imported_at
      ) VALUES (
        ${publishedInvoice.invoiceId}, ${publishedInvoice.customerId},
        ${publishedInvoice.expectedMint},
        ${publishedInvoice.destinationTokenAccount},
        ${publishedInvoice.amountBaseUnits.toString()},
        ${publishedInvoice.referenceAddress}, ${publishedInvoice.issuedAt},
        ${publishedInvoice.dueAt}, 'legacy-boundary-row', ${decidedAt}
      )
    `;
    await sql`
      DELETE FROM payops_schema_migrations
      WHERE name = '1004_event_contract_bounds'
    `;
    await runMigrations(databaseUrl);
    await expect(
      sql<{ count: number }[]>`
        SELECT count(*)::integer AS count
        FROM payops_schema_migrations
        WHERE name = '1004_event_contract_bounds'
      `,
    ).resolves.toEqual([{ count: 1 }]);
    await seedFinalizedEvent();
    await sql`
      INSERT INTO webhook_endpoints (
        id, url, secret_env, state, created_at, updated_at
      ) VALUES (
        'merchant-api', 'https://hooks.example.com/payops',
        'MERCHANT_WEBHOOK_SECRET', 'active', ${decidedAt}, ${decidedAt}
      )
    `;
    const [candidate] = await store.listFinalizedCandidates();
    const decision = reconcileEvent(candidate!, await store.listInvoices());
    expect(decision.kind).toBe("allocation");

    await expect(store.recordDecision(decision, decidedAt)).resolves.toBe(true);
    await expect(store.recordDecision(decision, decidedAt)).resolves.toBe(
      false,
    );

    const [counts] = await sql<
      { allocations: number; events: number; deliveries: number }[]
    >`
      SELECT
        (SELECT count(*)::integer FROM reconciliation_allocations) AS allocations,
        (SELECT count(*)::integer FROM webhook_events
          WHERE event_type = 'invoice.paid') AS events,
        (SELECT count(*)::integer FROM webhook_deliveries) AS deliveries
    `;
    expect(counts).toEqual({ allocations: 1, events: 1, deliveries: 1 });

    const [row] = await sql<{ status: string; payload: string }[]>`
      SELECT invoice.status, event.payload
      FROM reconciliation_invoices AS invoice
      JOIN webhook_events AS event
        ON event.source_type = 'invoice'
       AND event.source_id = invoice.invoice_id
      WHERE invoice.invoice_id = ${publishedInvoice.invoiceId}
    `;
    expect(row?.status).toBe("matched");
    expect(JSON.parse(row!.payload)).toMatchObject({
      type: "invoice.paid",
      occurredAt: decidedAt.toISOString(),
      statusAtOccurrence: "matched",
      object: { type: "invoice", id: publishedInvoice.invoiceId, version: 1 },
      data: {
        invoiceId: publishedInvoice.invoiceId,
        customerId: publishedInvoice.customerId,
        eventId: "event-001",
        signature: "signature-001",
        outerInstructionIndex: 0,
        innerInstructionIndex: null,
        mint: publishedInvoice.expectedMint,
        amountBaseUnits: publishedInvoice.amountBaseUnits.toString(),
        ruleCode: "exact_match",
        ruleVersion: "0.1",
      },
    });
    expect(parseLifecycleEventEnvelope(JSON.parse(row!.payload))).not.toBe(
      null,
    );
  });

  it("rolls back allocation and invoice status when event enqueue fails", async () => {
    await store.importInvoices([invoice], new Date());
    await seedFinalizedEvent();
    const [candidate] = await store.listFinalizedCandidates();
    const decision = reconcileEvent(candidate!, await store.listInvoices());
    await sql.unsafe(`
      CREATE OR REPLACE FUNCTION payops_test_reject_webhook_event()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'forced webhook outbox failure';
      END;
      $$;
      CREATE TRIGGER payops_test_reject_webhook_event
        BEFORE INSERT ON webhook_events
        FOR EACH ROW EXECUTE FUNCTION payops_test_reject_webhook_event();
    `);

    try {
      await expect(store.recordDecision(decision, new Date())).rejects.toThrow(
        /forced webhook outbox failure/,
      );
    } finally {
      await sql.unsafe(`
        DROP TRIGGER IF EXISTS payops_test_reject_webhook_event ON webhook_events;
        DROP FUNCTION IF EXISTS payops_test_reject_webhook_event();
      `);
    }

    const [result] = await sql<
      { allocations: number; events: number; status: string }[]
    >`
      SELECT
        (SELECT count(*)::integer FROM reconciliation_allocations) AS allocations,
        (SELECT count(*)::integer FROM webhook_events) AS events,
        (SELECT status FROM reconciliation_invoices
          WHERE invoice_id = ${invoice.invoiceId}) AS status
    `;
    expect(result).toEqual({ allocations: 0, events: 0, status: "open" });
  });

  it("atomically publishes one payment.exception_created event", async () => {
    const decidedAt = new Date("2026-08-07T12:00:00.000Z");
    await store.importInvoices([invoice], new Date());
    await seedFinalizedEvent({ mint: "different-mint" });
    await sql`
      INSERT INTO webhook_endpoints (
        id, url, secret_env, state, created_at, updated_at
      ) VALUES (
        'merchant-api', 'https://hooks.example.com/payops',
        'MERCHANT_WEBHOOK_SECRET', 'active', ${decidedAt}, ${decidedAt}
      )
    `;
    const [candidate] = await store.listFinalizedCandidates();
    const decision = reconcileEvent(candidate!, await store.listInvoices());
    expect(decision).toMatchObject({
      kind: "exception",
      code: "wrong_asset",
      invoiceId: invoice.invoiceId,
    });

    await expect(store.recordDecision(decision, decidedAt)).resolves.toBe(true);
    await expect(store.recordDecision(decision, decidedAt)).resolves.toBe(
      false,
    );

    const [row] = await sql<
      {
        exceptions: number;
        events: number;
        deliveries: number;
        status: string;
        exception_id: string;
        payload: string;
      }[]
    >`
      SELECT
        (SELECT count(*)::integer FROM reconciliation_exceptions) AS exceptions,
        (SELECT count(*)::integer FROM webhook_events
          WHERE event_type = 'payment.exception_created') AS events,
        (SELECT count(*)::integer FROM webhook_deliveries) AS deliveries,
        invoice.status,
        exception.id::text AS exception_id,
        event.payload
      FROM reconciliation_invoices AS invoice
      JOIN reconciliation_exceptions AS exception
        ON exception.invoice_id = invoice.invoice_id
      JOIN webhook_events AS event
        ON event.source_type = 'payment_exception'
       AND event.source_id = exception.id::text
      WHERE invoice.invoice_id = ${invoice.invoiceId}
    `;
    expect(row).toMatchObject({
      exceptions: 1,
      events: 1,
      deliveries: 1,
      status: "exception",
    });
    expect(JSON.parse(row!.payload)).toMatchObject({
      type: "payment.exception_created",
      statusAtOccurrence: "open",
      object: {
        type: "payment_exception",
        id: row!.exception_id,
        version: 1,
      },
      data: {
        exceptionId: row!.exception_id,
        invoiceId: invoice.invoiceId,
        eventId: "event-001",
        signature: "signature-001",
        outerInstructionIndex: 0,
        innerInstructionIndex: null,
        amountBaseUnits: invoice.amountBaseUnits.toString(),
        code: "wrong_asset",
        ruleVersion: "0.1",
        reviewState: "open",
      },
    });
    expect(parseLifecycleEventEnvelope(JSON.parse(row!.payload))).not.toBe(
      null,
    );
  });

  it("rejects forged persisted-evidence fields without side effects", async () => {
    await store.importInvoices([invoice], new Date());
    await seedFinalizedEvent();
    const [candidate] = await store.listFinalizedCandidates();
    const decision = reconcileEvent(candidate!, await store.listInvoices());

    await expect(
      store.recordDecision(
        {
          ...decision,
          eventId: "forged-event",
          signature: "forged-signature",
          outerInstructionIndex: 99,
          innerInstructionIndex: 98,
          amountBaseUnits: 1n,
        },
        new Date(),
      ),
    ).resolves.toBe(false);
    const [counts] = await sql<
      { allocations: number; exceptions: number; events: number }[]
    >`
      SELECT
        (SELECT count(*)::integer FROM reconciliation_allocations) AS allocations,
        (SELECT count(*)::integer FROM reconciliation_exceptions) AS exceptions,
        (SELECT count(*)::integer FROM webhook_events) AS events
    `;
    expect(counts).toEqual({ allocations: 0, exceptions: 0, events: 0 });
    await expect(store.listInvoices()).resolves.toMatchObject([
      { invoiceId: invoice.invoiceId, status: "open" },
    ]);
  });

  it("rejects a forged invoice ID without updating an unrelated invoice", async () => {
    await store.importInvoices([invoice, unrelatedInvoice], new Date());
    await seedFinalizedEvent();
    const [candidate] = await store.listFinalizedCandidates();
    const decision = reconcileEvent(candidate!, await store.listInvoices());

    await expect(
      store.recordDecision(
        { ...decision, invoiceId: unrelatedInvoice.invoiceId },
        new Date(),
      ),
    ).resolves.toBe(false);
    await expect(store.listInvoices()).resolves.toMatchObject([
      { invoiceId: invoice.invoiceId, status: "open" },
      { invoiceId: unrelatedInvoice.invoiceId, status: "open" },
    ]);
    await expect(
      sql<{ count: number }[]>`
        SELECT (
          (SELECT count(*) FROM reconciliation_allocations)
          + (SELECT count(*) FROM reconciliation_exceptions)
          + (SELECT count(*) FROM webhook_events)
        )::integer AS count
      `,
    ).resolves.toEqual([{ count: 0 }]);
  });

  it("rejects forged classification, code, and rule version", async () => {
    await store.importInvoices([invoice], new Date());
    await seedFinalizedEvent();
    const [candidate] = await store.listFinalizedCandidates();
    const decision = reconcileEvent(candidate!, await store.listInvoices());

    const forged = [
      { ...decision, kind: "exception", code: "wrong_asset" },
      { ...decision, ruleVersion: "99.0" },
    ] as unknown as ReconciliationDecision[];
    for (const candidateDecision of forged) {
      await expect(
        store.recordDecision(candidateDecision, new Date()),
      ).resolves.toBe(false);
    }
    await expect(
      sql<{ count: number }[]>`
        SELECT (
          (SELECT count(*) FROM reconciliation_allocations)
          + (SELECT count(*) FROM reconciliation_exceptions)
          + (SELECT count(*) FROM webhook_events)
        )::integer AS count
      `,
    ).resolves.toEqual([{ count: 0 }]);
  });

  it("rejects a stale allocation after the canonical representation changes", async () => {
    await store.importInvoices([invoice], new Date());
    await seedFinalizedEvent();
    const [candidate] = await store.listFinalizedCandidates();
    const staleDecision = reconcileEvent(
      candidate!,
      await store.listInvoices(),
    );
    expect(staleDecision.kind).toBe("allocation");
    await insertTransferRepresentation("0.3.0", { mint: "different-mint" });

    await expect(store.recordDecision(staleDecision, new Date())).resolves.toBe(
      false,
    );
    await expect(store.listInvoices()).resolves.toMatchObject([
      { invoiceId: invoice.invoiceId, status: "open" },
    ]);
  });

  it("emits nullable-invoice exceptions with complete persisted evidence", async () => {
    const decidedAt = new Date("2026-08-07T12:00:00.000Z");
    await seedFinalizedEvent();
    const [candidate] = await store.listFinalizedCandidates();
    const decision = reconcileEvent(candidate!, []);
    expect(decision).toMatchObject({
      kind: "exception",
      code: "unknown_reference",
      invoiceId: null,
    });

    await expect(store.recordDecision(decision, decidedAt)).resolves.toBe(true);
    const [row] = await sql<{ exception_id: string; payload: string }[]>`
      SELECT exception.id::text AS exception_id, event.payload
      FROM reconciliation_exceptions AS exception
      JOIN webhook_events AS event
        ON event.source_id = exception.id::text
    `;
    expect(JSON.parse(row!.payload)).toMatchObject({
      statusAtOccurrence: "open",
      object: {
        type: "payment_exception",
        id: row!.exception_id,
        version: 1,
      },
      data: {
        exceptionId: row!.exception_id,
        invoiceId: null,
        eventId: "event-001",
        signature: "signature-001",
        outerInstructionIndex: 0,
        innerInstructionIndex: null,
        amountBaseUnits: invoice.amountBaseUnits.toString(),
        code: "unknown_reference",
        ruleVersion: "0.1",
        reviewState: "open",
      },
    });
  });

  it("selects parser representations by semantic version", async () => {
    await store.importInvoices([invoice], new Date());
    await seedFinalizedEvent();
    await insertTransferRepresentation("0.9.0", { mint: "older-mint" });
    await insertTransferRepresentation("0.10.0");

    const [candidate] = await store.listFinalizedCandidates();
    expect(candidate).toMatchObject({
      mint: invoice.expectedMint,
      amountBaseUnits: invoice.amountBaseUnits,
    });
    const decision = reconcileEvent(candidate!, await store.listInvoices());
    expect(decision.kind).toBe("allocation");
  });

  it("uses one captured parser representation for decision and payload", async () => {
    const decidedAt = new Date("2026-08-07T12:00:00.000Z");
    await store.importInvoices([invoice], new Date());
    await seedFinalizedEvent();
    const [candidate] = await store.listFinalizedCandidates();
    const decision = reconcileEvent(candidate!, await store.listInvoices());
    await sql.unsafe(`
      CREATE OR REPLACE FUNCTION payops_test_insert_new_parser_representation()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO normalized_transfers (
          chain_event_id, parser_version, program_id, source_token_account,
          source_account_index, mint, destination_token_account,
          destination_account_index, authority, amount_base_units, decimals
        ) VALUES (
          NEW.chain_event_id, '9.0.0',
          'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
          '8rUz82MkFsfqjpVjjgWEM66Brr1sm1R7VKZ991fF41e', 1,
          'newer-mint', '${invoice.destinationTokenAccount}', 2,
          '4wBqpZM9xaSheZzJSMawUKKwhdpChKbZ5eu5ky4Vigw', 1, 6
        );
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER payops_test_insert_new_parser_representation
        AFTER INSERT ON reconciliation_allocations
        FOR EACH ROW
        EXECUTE FUNCTION payops_test_insert_new_parser_representation();
    `);

    try {
      await expect(store.recordDecision(decision, decidedAt)).resolves.toBe(
        true,
      );
    } finally {
      await sql.unsafe(`
        DROP TRIGGER IF EXISTS payops_test_insert_new_parser_representation
          ON reconciliation_allocations;
        DROP FUNCTION IF EXISTS payops_test_insert_new_parser_representation();
      `);
    }
    const [row] = await sql<{ amount_base_units: string; payload: string }[]>`
      SELECT allocation.amount_base_units::text, event.payload
      FROM reconciliation_allocations AS allocation
      JOIN webhook_events AS event
        ON event.source_id = allocation.invoice_id
    `;
    expect(row?.amount_base_units).toBe(invoice.amountBaseUnits.toString());
    expect(JSON.parse(row!.payload)).toMatchObject({
      data: {
        mint: invoice.expectedMint,
        amountBaseUnits: invoice.amountBaseUnits.toString(),
      },
    });
  });

  it("rejects non-mainnet events after candidate selection", async () => {
    await seedFinalizedEvent();
    const [event] = await sql<{ id: string }[]>`
      SELECT id::text FROM chain_events WHERE event_id = 'event-001'
    `;
    const [candidate] = await store.listFinalizedCandidates();
    await sql`UPDATE chain_events SET cluster = 'devnet' WHERE id = ${event!.id}`;
    await expect(store.listFinalizedCandidates()).resolves.toEqual([]);
    await expect(
      store.recordDecision(reconcileEvent(candidate!, []), new Date()),
    ).resolves.toBe(false);
  });

  it("prevents an event from receiving contradictory decisions", async () => {
    await store.importInvoices([invoice], new Date());
    await seedFinalizedEvent();
    const [event] = await store.listFinalizedCandidates();
    const allocation = reconcileEvent(event!, await store.listInvoices());
    expect(allocation.kind).toBe("allocation");
    await expect(store.recordDecision(allocation, new Date())).resolves.toBe(
      true,
    );
    await expect(
      store.recordDecision(
        {
          ...allocation,
          kind: "exception",
          code: "duplicate_payment",
        },
        new Date(),
      ),
    ).resolves.toBe(false);
    const [counts] = await sql<{ allocations: number; exceptions: number }[]>`
      SELECT
        (SELECT count(*)::integer FROM reconciliation_allocations) AS allocations,
        (SELECT count(*)::integer FROM reconciliation_exceptions) AS exceptions
    `;
    expect(counts).toEqual({ allocations: 1, exceptions: 0 });
  });

  it("records completed reconciliation runs with their counts", async () => {
    const runId = await store.startRun(new Date("2026-08-07T00:00:00.000Z"));
    await store.completeRun(
      runId,
      "complete",
      { candidates: 2, allocations: 1, exceptions: 1, applied: 2 },
      new Date("2026-08-07T00:00:01.000Z"),
    );
    const rows = await sql`
      SELECT result, candidates, allocations, exceptions, applied, completed_at
      FROM reconciliation_runs WHERE id = ${runId}
    `;
    expect(rows).toMatchObject([
      {
        result: "complete",
        candidates: 2,
        allocations: 1,
        exceptions: 1,
        applied: 2,
        completed_at: new Date("2026-08-07T00:00:01.000Z"),
      },
    ]);
  });

  it("summarizes only selected invoices and watches, including unmatched value", async () => {
    await store.importInvoices([invoice, unrelatedInvoice], nowForAudit());
    await seedFinalizedEvent();
    const [candidate] = await store.listFinalizedCandidates();
    await store.recordDecision(
      reconcileEvent(candidate!, await store.listInvoices()),
      nowForAudit(),
    );
    await sql`
      INSERT INTO watch_targets (
        id, provider_id, cluster, address, cutover_slot, overlap_slots,
        committed_head_slot, coverage, created_at
      ) VALUES
        ('audit-watch', 'primary', 'mainnet-beta',
         'Cmn8RVNLZAtyq51B31RXDrrS24DYphEftzDCX4FzPLM', 1, 64, 10,
         'complete', ${nowForAudit()}),
        ('unrelated-watch', 'primary', 'mainnet-beta',
         '8rUz82MkFsfqjpVjjgWEM66Brr1sm1R7VKZ991fF41e', 1, 64, 10,
         'complete', ${nowForAudit()})
    `;
    const rawRows = await sql<{ id: string }[]>`
      INSERT INTO raw_transactions (
        provider_id, signature, commitment, digest, canonical_body, body,
        byte_length, retrieved_at
      ) VALUES
        ('primary', 'signature-002', 'finalized', 'digest-2', '{}', '{}'::jsonb, 2, ${nowForAudit()}),
        ('primary', 'signature-003', 'finalized', 'digest-3', '{}', '{}'::jsonb, 2, ${nowForAudit()})
      RETURNING id::text
    `;
    await sql`
      INSERT INTO chain_events (
        event_id, cluster, signature, outer_instruction_index,
        inner_instruction_index, raw_transaction_id, current_state
      ) VALUES
        ('event-002', 'mainnet-beta', 'signature-002', 0, -1, ${rawRows[0]!.id}, 'finalized'),
        ('event-003', 'mainnet-beta', 'signature-003', 0, -1, ${rawRows[1]!.id}, 'finalized')
    `;
    await sql`
      INSERT INTO discovered_signatures (
        watch_target_id, provider_id, signature, slot, confirmation_status,
        representation_class, finality_state, observed_at
      ) VALUES
        ('audit-watch', 'primary', 'signature-001', 1, 'finalized', 'parsed', 'finalized', ${nowForAudit()}),
        ('audit-watch', 'primary', 'signature-002', 2, 'finalized', 'parsed', 'finalized', ${nowForAudit()}),
        ('unrelated-watch', 'primary', 'signature-003', 3, 'finalized', 'parsed', 'finalized', ${nowForAudit()})
    `;

    const first = await store.getAuditSummary(
      [invoice.invoiceId],
      ["audit-watch"],
    );
    const second = await store.getAuditSummary(
      [invoice.invoiceId],
      ["audit-watch"],
    );

    expect(second).toEqual(first);
    expect(first).toEqual({
      invoiceCount: 1,
      allocationCount: 1,
      exceptionCount: 0,
      exceptionsByCode: {},
      unmatchedFinalizedEvents: 1,
    });
    await expect(
      store.getAuditRows([invoice.invoiceId], ["audit-watch"]),
    ).resolves.toEqual([
      {
        invoiceId: invoice.invoiceId,
        customerId: invoice.customerId,
        status: "matched",
        expectedMint: invoice.expectedMint,
        amountBaseUnits: invoice.amountBaseUnits.toString(),
        eventId: "event-001",
        ruleCode: "exact_match",
      },
    ]);
    expect(JSON.stringify(first)).not.toContain("canonical_body");
    expect(JSON.stringify(first)).not.toContain("signature-002");
  });
});

function nowForAudit(): Date {
  return new Date("2026-08-10T00:00:00.000Z");
}
