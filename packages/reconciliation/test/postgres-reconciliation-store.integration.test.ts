import { runMigrations as runIngestionMigrations } from "@payops/ingestion";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  PostgresReconciliationStore,
  ReconciliationError,
  reconcileEvent,
  runMigrations,
  type InvoiceImport,
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

async function seedFinalizedEvent(): Promise<void> {
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
      ${invoice.expectedMint}, ${invoice.destinationTokenAccount}, 2,
      '4wBqpZM9xaSheZzJSMawUKKwhdpChKbZ5eu5ky4Vigw',
      ${invoice.amountBaseUnits.toString()}, 6
    )
  `;
  await sql`
    INSERT INTO event_references (chain_event_id, reference_address)
    VALUES (${eventId}, ${invoice.referenceAddress})
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

  it("selects one latest mainnet representation per finalized event", async () => {
    await seedFinalizedEvent();
    const [event] = await sql<{ id: string }[]>`
      SELECT id::text FROM chain_events WHERE event_id = 'event-001'
    `;
    await sql`
      INSERT INTO normalized_transfers (
        chain_event_id, parser_version, program_id, source_token_account,
        source_account_index, mint, destination_token_account,
        destination_account_index, authority, amount_base_units, decimals
      ) VALUES (
        ${event!.id}, '0.3.0', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        '8rUz82MkFsfqjpVjjgWEM66Brr1sm1R7VKZ991fF41e', 1,
        ${invoice.expectedMint}, ${invoice.destinationTokenAccount}, 2,
        '4wBqpZM9xaSheZzJSMawUKKwhdpChKbZ5eu5ky4Vigw',
        ${invoice.amountBaseUnits.toString()}, 6
      )
    `;

    const [candidate] = await store.listFinalizedCandidates();
    expect(candidate).toBeDefined();
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
});
