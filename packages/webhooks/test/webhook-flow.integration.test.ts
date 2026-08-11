import { createHash } from "node:crypto";
import { runMigrations as runIngestionMigrations } from "../../ingestion/src/storage/migrate.js";
import type { InvoiceImport } from "../../reconciliation/src/domain/types.js";
import { runReconciliation } from "../../reconciliation/src/reconciliation-service.js";
import { runMigrations as runReconciliationMigrations } from "../../reconciliation/src/storage/migrate.js";
import { PostgresReconciliationStore } from "../../reconciliation/src/storage/postgres-reconciliation-store.js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  parseLifecycleEventEnvelope,
  PostgresWebhookStore,
  runDeliveryBatch,
  verifyWebhook,
  type DeliveryTransportRequest,
} from "../src/index.js";
import { TEST_SIGNATURE } from "./support/lifecycle-events.js";

const baseDatabaseUrl =
  process.env.DATABASE_URL ??
  "postgres://payops:payops@127.0.0.1:55432/payops_test";
const schema = "webhook_flow_e2e";
const databaseUrl = databaseUrlForSchema(baseDatabaseUrl, schema);
const adminSql = postgres(baseDatabaseUrl, { max: 1 });
const sql = postgres(databaseUrl, { max: 1 });

const invoice: InvoiceImport = {
  invoiceId: "inv-e2e-001",
  customerId: "customer-e2e-001",
  expectedMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  destinationTokenAccount: "Cmn8RVNLZAtyq51B31RXDrrS24DYphEftzDCX4FzPLM",
  amountBaseUnits: 12_500_000n,
  referenceAddress: "Gh5GixNvrU87vKWcLLLp6dcgBGRDtP4EJesFu6rjif4",
  issuedAt: new Date("2026-08-01T00:00:00.000Z"),
  dueAt: new Date("2026-08-15T00:00:00.000Z"),
};
const reconciledAt = new Date("2026-08-10T12:00:00.000Z");
const webhookSecret = "e2e-secret-value";
let reconciliationStore: PostgresReconciliationStore;
let webhookStore: PostgresWebhookStore;

beforeAll(async () => {
  await adminSql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await adminSql.unsafe(`CREATE SCHEMA ${schema}`);
  await runIngestionMigrations(databaseUrl);
  await runReconciliationMigrations(databaseUrl);
  await runReconciliationMigrations(databaseUrl);
  reconciliationStore = new PostgresReconciliationStore({ databaseUrl });
  webhookStore = new PostgresWebhookStore({
    databaseUrl,
    endpointPolicy: { allowUnsafeAddressesForTesting: true },
  });
});

afterAll(async () => {
  await reconciliationStore?.close();
  await webhookStore?.close();
  await sql.end();
  await adminSql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await adminSql.end();
});

describe("transactional lifecycle webhook flow", () => {
  it("reconciles once and retries the same signed event bytes to success", async () => {
    await expect(
      webhookStore.addEndpoint(
        {
          id: "local-receiver",
          url: "https://127.0.0.1/payops",
          secretEnv: "E2E_WEBHOOK_SECRET",
        },
        reconciledAt,
      ),
    ).resolves.toEqual({ inserted: true });
    await reconciliationStore.importInvoices([invoice], reconciledAt);
    await seedFinalizedPayment();

    await expect(
      runReconciliation(reconciliationStore, reconciledAt),
    ).resolves.toEqual({
      candidates: 1,
      allocations: 1,
      exceptions: 0,
      applied: 1,
    });
    await expect(
      runReconciliation(reconciliationStore, reconciledAt),
    ).resolves.toEqual({
      candidates: 0,
      allocations: 0,
      exceptions: 0,
      applied: 0,
    });

    const [eventRow] = await sql<{ id: string }[]>`
      SELECT id::text FROM webhook_events
    `;
    expect(eventRow).toBeDefined();
    const initial = await webhookStore.inspectEvent(eventRow!.id);
    expect(initial).toMatchObject({
      eventType: "invoice.paid",
      sourceId: invoice.invoiceId,
      deliveries: [
        {
          endpointId: "local-receiver",
          state: "pending",
          attemptCount: 0,
          attempts: [],
        },
      ],
    });
    expect(parseLifecycleEventEnvelope(JSON.parse(initial!.payload))).not.toBe(
      null,
    );
    expect(
      createHash("sha256").update(initial!.payload, "utf8").digest("hex"),
    ).toBe(initial!.digest);

    const receiver = new ControlledReceiver([500, 204]);
    let deliveryNow = reconciledAt;
    const options = {
      limit: 1,
      leaseMs: 30_000,
      now: () => deliveryNow,
      random: () => 0.5,
    };

    await expect(
      runDeliveryBatch(
        webhookStore,
        receiver,
        { E2E_WEBHOOK_SECRET: webhookSecret },
        options,
      ),
    ).resolves.toEqual({
      claimed: 1,
      succeeded: 0,
      retryScheduled: 1,
      dead: 0,
      leaseLost: 0,
    });
    const afterFailure = await webhookStore.inspectEvent(initial!.id);
    expect(afterFailure).toMatchObject({
      payload: initial!.payload,
      digest: initial!.digest,
      deliveries: [
        {
          state: "retry_wait",
          attemptCount: 1,
          lastStatusCode: 500,
          lastErrorCode: "http_500",
          attempts: [
            { attemptNumber: 1, outcome: "retry_wait", httpStatus: 500 },
          ],
        },
      ],
    });

    deliveryNow = afterFailure!.deliveries[0]!.nextAttemptAt!;
    await expect(
      runDeliveryBatch(
        webhookStore,
        receiver,
        { E2E_WEBHOOK_SECRET: webhookSecret },
        options,
      ),
    ).resolves.toEqual({
      claimed: 1,
      succeeded: 1,
      retryScheduled: 0,
      dead: 0,
      leaseLost: 0,
    });

    const completed = await webhookStore.inspectEvent(initial!.id);
    expect(completed).toMatchObject({
      payload: initial!.payload,
      digest: initial!.digest,
      deliveries: [
        {
          state: "succeeded",
          attemptCount: 2,
          lastStatusCode: 204,
          lastErrorCode: null,
          attempts: [
            { attemptNumber: 1, outcome: "retry_wait", httpStatus: 500 },
            { attemptNumber: 2, outcome: "succeeded", httpStatus: 204 },
          ],
        },
      ],
    });
    expect(receiver.requests).toHaveLength(2);
    expect(receiver.requests[0]!.body).toBe(initial!.payload);
    expect(receiver.requests[1]!.body).toBe(initial!.payload);
    expect(receiver.requests[1]!.headers["payops-event-id"]).toBe(
      receiver.requests[0]!.headers["payops-event-id"],
    );
    expect(receiver.requests[1]!.headers["payops-delivery-id"]).toBe(
      receiver.requests[0]!.headers["payops-delivery-id"],
    );
    for (const request of receiver.requests) {
      expect(
        verifyWebhook(
          {
            body: request.body,
            timestamp: request.headers["payops-timestamp"]!,
            signature: request.headers["payops-signature"]!,
          },
          [webhookSecret],
          new Date(Number(request.headers["payops-timestamp"]) * 1_000),
        ),
      ).toEqual({ ok: true, secretIndex: 0 });
    }

    await expect(
      sql<
        {
          events: number;
          deliveries: number;
          attempts: number;
          allocations: number;
        }[]
      >`
        SELECT
          (SELECT count(*)::integer FROM webhook_events) AS events,
          (SELECT count(*)::integer FROM webhook_deliveries) AS deliveries,
          (SELECT count(*)::integer FROM webhook_delivery_attempts) AS attempts,
          (SELECT count(*)::integer FROM reconciliation_allocations) AS allocations
      `,
    ).resolves.toEqual([
      { events: 1, deliveries: 1, attempts: 2, allocations: 1 },
    ]);
  });
});

class ControlledReceiver {
  readonly requests: DeliveryTransportRequest[] = [];
  readonly #statuses: number[];

  public constructor(statuses: number[]) {
    this.#statuses = [...statuses];
  }

  public async send(request: DeliveryTransportRequest) {
    this.requests.push(request);
    const status = this.#statuses.shift();
    if (status === undefined) throw new Error("Missing receiver response");
    return { status };
  }
}

async function seedFinalizedPayment(): Promise<void> {
  await sql`
    INSERT INTO rpc_providers (id, cluster, endpoint_env, endpoint_label)
    VALUES ('e2e-provider', 'mainnet-beta', 'SOLANA_RPC_URL', 'e2e')
  `;
  const [raw] = await sql<{ id: string }[]>`
    INSERT INTO raw_transactions (
      provider_id, signature, commitment, digest, canonical_body, body,
      byte_length, retrieved_at
    ) VALUES (
      'e2e-provider', ${TEST_SIGNATURE}, 'finalized', 'e2e-digest', '{}',
      ${sql.json({ blockTime: 1_786_320_000 })},
      2, '2026-08-10T00:00:00.000Z'
    ) RETURNING id::text
  `;
  const [event] = await sql<{ id: string }[]>`
    INSERT INTO chain_events (
      event_id, cluster, signature, outer_instruction_index,
      inner_instruction_index, raw_transaction_id, current_state
    ) VALUES (
      'e2e-event', 'mainnet-beta', ${TEST_SIGNATURE}, 0, -1,
      ${raw!.id}, 'finalized'
    ) RETURNING id::text
  `;
  await sql`
    INSERT INTO normalized_transfers (
      chain_event_id, parser_version, program_id, source_token_account,
      source_account_index, mint, destination_token_account,
      destination_account_index, authority, amount_base_units, decimals
    ) VALUES (
      ${event!.id}, '0.2.0',
      'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      '8rUz82MkFsfqjpVjjgWEM66Brr1sm1R7VKZ991fF41e', 1,
      ${invoice.expectedMint}, ${invoice.destinationTokenAccount}, 2,
      '4wBqpZM9xaSheZzJSMawUKKwhdpChKbZ5eu5ky4Vigw',
      ${invoice.amountBaseUnits.toString()}, 6
    )
  `;
  await sql`
    INSERT INTO event_references (chain_event_id, reference_address)
    VALUES (${event!.id}, ${invoice.referenceAddress})
  `;
}

function databaseUrlForSchema(databaseUrl: string, schemaName: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set("options", `-csearch_path=${schemaName}`);
  return url.toString();
}
