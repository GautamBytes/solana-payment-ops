import { createHash, randomUUID } from "node:crypto";
import { stringifyCanonical } from "@payops/core";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createLifecycleEvent,
  enqueueLifecycleEvent,
  PostgresWebhookStore,
  runDeliveryBatch,
  runMigrations,
  type DeliveryTransportRequest,
} from "../src/index.js";
import {
  lifecycleInputs,
  TEST_MINT,
  TEST_SIGNATURE,
} from "./support/lifecycle-events.js";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://payops:payops@127.0.0.1:55432/payops_test";
const sql = postgres(databaseUrl, { max: 4 });
const now = new Date("2026-08-07T10:00:00.000Z");
let store: PostgresWebhookStore;

function invoicePaidEvent(
  id = randomUUID(),
  sourceId = "invoice-001",
  amountBaseUnits = "12500000",
) {
  return createLifecycleEvent(
    {
      type: "invoice.paid",
      statusAtOccurrence: "matched",
      object: { type: "invoice", id: sourceId, version: 1 },
      data: {
        invoiceId: sourceId,
        customerId: "customer-001",
        eventId: "event-001",
        signature: TEST_SIGNATURE,
        outerInstructionIndex: 0,
        innerInstructionIndex: null,
        mint: TEST_MINT,
        amountBaseUnits,
        ruleCode: "exact_match",
        ruleVersion: "0.1.0",
      },
    },
    id,
    now,
  );
}

beforeAll(async () => {
  await runMigrations(databaseUrl);
  await runMigrations(databaseUrl);
  store = new PostgresWebhookStore({ databaseUrl });
});

beforeEach(async () => {
  await sql.unsafe(`
    TRUNCATE TABLE
      webhook_delivery_attempts,
      webhook_deliveries,
      webhook_events,
      webhook_endpoints
    RESTART IDENTITY CASCADE
  `);
});

afterAll(async () => {
  await store.close();
  await sql.end();
});

describe("PostgresWebhookStore", () => {
  it("applies the transactional webhook migration idempotently", async () => {
    const rows = await sql<{ name: string; count: number }[]>`
      SELECT name, count(*)::integer AS count
      FROM payops_schema_migrations
      WHERE name IN (
        '2001_transactional_webhooks',
        '2002_lifecycle_contract_v0_1'
      )
      GROUP BY name
      ORDER BY name
    `;
    expect(rows).toEqual([
      { name: "2001_transactional_webhooks", count: 1 },
      { name: "2002_lifecycle_contract_v0_1", count: 1 },
    ]);
  });

  it("persists invoice.cancelled through the v0.1 contract migration", async () => {
    const event = createLifecycleEvent(
      lifecycleInputs[1],
      "5af0f165-54d5-49d7-99bf-9686888b857d",
      now,
    );

    await expect(
      sql.begin((transaction) =>
        enqueueLifecycleEvent(transaction, event, now),
      ),
    ).resolves.toBe(event.id);
    await expect(store.inspectEvent(event.id)).resolves.toMatchObject({
      eventType: "invoice.cancelled",
      sourceType: "invoice",
      sourceId: "invoice-001",
    });
  });

  it("records the v0.1 migration when its constraints already exist", async () => {
    await sql`
      DELETE FROM payops_schema_migrations
      WHERE name = '2002_lifecycle_contract_v0_1'
    `;

    await expect(runMigrations(databaseUrl)).resolves.toBeUndefined();
    await expect(runMigrations(databaseUrl)).resolves.toBeUndefined();
    const rows = await sql<{ count: number }[]>`
      SELECT count(*)::integer AS count
      FROM payops_schema_migrations
      WHERE name = '2002_lifecycle_contract_v0_1'
    `;
    expect(rows).toEqual([{ count: 1 }]);
  });

  it("enqueues all 13 exact event variants and rejects invalid data first", async () => {
    for (const input of lifecycleInputs) {
      const event = createLifecycleEvent(input, randomUUID(), now);
      const envelope = JSON.parse(event.payload) as Record<string, unknown>;
      const invalidPayload = stringifyCanonical({ ...envelope, data: {} });

      await expect(
        sql.begin((transaction) =>
          enqueueLifecycleEvent(
            transaction,
            {
              ...event,
              payload: invalidPayload,
              digest: createHash("sha256")
                .update(invalidPayload, "utf8")
                .digest("hex"),
            },
            now,
          ),
        ),
      ).rejects.toThrow(/envelope/i);
      await expect(
        sql.begin((transaction) =>
          enqueueLifecycleEvent(transaction, event, now),
        ),
      ).resolves.toBe(event.id);
    }

    const rows = await sql<{ count: number }[]>`
      SELECT count(*)::integer AS count FROM webhook_events
    `;
    expect(rows).toEqual([{ count: 13 }]);
  });

  it("adds identical endpoints idempotently and rejects reused IDs", async () => {
    const endpoint = {
      id: "merchant-api",
      url: "https://hooks.example.com/payops",
      secretEnv: "MERCHANT_WEBHOOK_SECRET",
    };
    await expect(store.addEndpoint(endpoint, now)).resolves.toEqual({
      inserted: true,
    });
    await expect(store.addEndpoint(endpoint, now)).resolves.toEqual({
      inserted: false,
    });
    await expect(
      store.addEndpoint(
        { ...endpoint, url: "https://other.example.com/payops" },
        now,
      ),
    ).rejects.toThrow(/different configuration/i);
    await expect(
      store.addEndpoint(
        { ...endpoint, secretEnv: "OTHER_WEBHOOK_SECRET" },
        now,
      ),
    ).rejects.toThrow(/different configuration/i);

    await expect(store.listEndpoints()).resolves.toEqual([
      {
        ...endpoint,
        previousSecretEnv: null,
        state: "active",
        createdAt: now,
        updatedAt: now,
      },
    ]);
  });

  it("validates secret references and stores environment names, never values", async () => {
    process.env.MERCHANT_WEBHOOK_SECRET = "must-not-be-persisted";
    try {
      await expect(
        store.addEndpoint(
          {
            id: "merchant-api",
            url: "https://hooks.example.com/payops",
            secretEnv: "not-an-env-name",
          },
          now,
        ),
      ).rejects.toThrow(/environment variable/i);
      await store.addEndpoint(
        {
          id: "merchant-api",
          url: "https://hooks.example.com/payops",
          secretEnv: "MERCHANT_WEBHOOK_SECRET",
        },
        now,
      );
      const rows = await sql<{ document: string }[]>`
        SELECT row_to_json(endpoint)::text AS document
        FROM webhook_endpoints AS endpoint
      `;
      expect(rows[0]?.document).toContain("MERCHANT_WEBHOOK_SECRET");
      expect(rows[0]?.document).not.toContain("must-not-be-persisted");
    } finally {
      delete process.env.MERCHANT_WEBHOOK_SECRET;
    }
  });

  it("permits unsafe endpoint addresses only through explicit test policy", async () => {
    const endpoint = {
      id: "local-test-receiver",
      url: "https://127.0.0.1/payops",
      secretEnv: "LOCAL_WEBHOOK_SECRET",
    };
    await expect(store.addEndpoint(endpoint, now)).rejects.toThrow(
      /not publicly routable/i,
    );
    const testStore = new PostgresWebhookStore({
      databaseUrl,
      endpointPolicy: { allowUnsafeAddressesForTesting: true },
    });
    try {
      await expect(testStore.addEndpoint(endpoint, now)).resolves.toEqual({
        inserted: true,
      });
    } finally {
      await testStore.close();
    }
  });

  it("rotates secret references while retaining one previous reference", async () => {
    const endpoint = {
      id: "merchant-api",
      url: "https://hooks.example.com/payops",
      secretEnv: "MERCHANT_WEBHOOK_SECRET_V1",
    };
    await store.addEndpoint(endpoint, now);
    await expect(
      store.rotateEndpointSecret(
        endpoint.id,
        "MERCHANT_WEBHOOK_SECRET_V2",
        new Date("2026-08-07T11:00:00.000Z"),
      ),
    ).resolves.toEqual({ rotated: true });
    await expect(
      store.rotateEndpointSecret(
        endpoint.id,
        "MERCHANT_WEBHOOK_SECRET_V2",
        new Date("2026-08-07T12:00:00.000Z"),
      ),
    ).resolves.toEqual({ rotated: false });
    await expect(store.listEndpoints()).resolves.toMatchObject([
      {
        id: endpoint.id,
        secretEnv: "MERCHANT_WEBHOOK_SECRET_V2",
        previousSecretEnv: "MERCHANT_WEBHOOK_SECRET_V1",
        updatedAt: new Date("2026-08-07T11:00:00.000Z"),
      },
    ]);
    await expect(
      store.rotateEndpointSecret("missing", "MERCHANT_WEBHOOK_SECRET", now),
    ).rejects.toThrow(/not found/i);
  });

  it("enqueues immutable event bytes and fans out once to active endpoints", async () => {
    await store.addEndpoint(
      {
        id: "merchant-api",
        url: "https://hooks.example.com/payops",
        secretEnv: "MERCHANT_WEBHOOK_SECRET",
      },
      now,
    );
    await store.addEndpoint(
      {
        id: "disabled-api",
        url: "https://disabled.example.com/payops",
        secretEnv: "DISABLED_WEBHOOK_SECRET",
      },
      now,
    );
    await sql`
      UPDATE webhook_endpoints SET state = 'disabled'
      WHERE id = 'disabled-api'
    `;
    const event = invoicePaidEvent("7f760956-98e0-42ce-acbe-969681eb3a9d");

    await expect(
      sql.begin((transaction) =>
        enqueueLifecycleEvent(transaction, event, now),
      ),
    ).resolves.toBe(event.id);
    await expect(
      sql.begin((transaction) =>
        enqueueLifecycleEvent(transaction, event, now),
      ),
    ).resolves.toBe(event.id);

    await expect(store.inspectEvent(event.id)).resolves.toMatchObject({
      id: event.id,
      eventType: event.eventType,
      payload: event.payload,
      digest: event.digest,
      deliveries: [
        {
          endpointId: "merchant-api",
          state: "pending",
          attemptCount: 0,
          attempts: [],
        },
      ],
    });
  });

  it("rejects changed payload bytes for an existing event source", async () => {
    const event = invoicePaidEvent("7f760956-98e0-42ce-acbe-969681eb3a9d");
    await sql.begin((transaction) =>
      enqueueLifecycleEvent(transaction, event, now),
    );
    const changed = invoicePaidEvent(
      "c93ad54c-71e8-4b86-b0e4-658bddb37e2e",
      "invoice-001",
      "1",
    );
    await expect(
      sql.begin((transaction) =>
        enqueueLifecycleEvent(transaction, changed, now),
      ),
    ).rejects.toThrow(/immutable payload/i);
    await expect(
      sql.begin((transaction) =>
        enqueueLifecycleEvent(
          transaction,
          { ...event, digest: "0".repeat(64) },
          now,
        ),
      ),
    ).rejects.toThrow(/digest/i);
  });

  it("rejects record metadata that disagrees with its canonical envelope", async () => {
    const event = invoicePaidEvent("7f760956-98e0-42ce-acbe-969681eb3a9d");
    const poisonedRecords = [
      { ...event, id: "c93ad54c-71e8-4b86-b0e4-658bddb37e2e" },
      { ...event, eventType: "payment.exception_created" as const },
      { ...event, sourceType: "payment_exception" as const },
      { ...event, sourceId: "invoice-002" },
      { ...event, sourceVersion: 2 },
      { ...event, occurredAt: new Date("2026-08-07T10:00:01.000Z") },
    ];
    for (const poisoned of poisonedRecords) {
      await expect(
        sql.begin((transaction) =>
          enqueueLifecycleEvent(transaction, poisoned, now),
        ),
      ).rejects.toThrow(/metadata.*canonical payload/i);
    }

    const legitimate = invoicePaidEvent(
      "c93ad54c-71e8-4b86-b0e4-658bddb37e2e",
      "invoice-002",
    );
    await expect(
      sql.begin((transaction) =>
        enqueueLifecycleEvent(transaction, legitimate, now),
      ),
    ).resolves.toBe(legitimate.id);
    await expect(store.inspectEvent(legitimate.id)).resolves.toMatchObject({
      sourceId: "invoice-002",
      payload: legitimate.payload,
    });

    const exception = createLifecycleEvent(
      {
        type: "payment.exception_created",
        statusAtOccurrence: "open",
        object: {
          type: "payment_exception",
          id: "exception-001",
          version: 1,
        },
        data: {
          exceptionId: "exception-001",
          invoiceId: null,
          eventId: "event-003",
          signature: TEST_SIGNATURE,
          outerInstructionIndex: 2,
          innerInstructionIndex: null,
          amountBaseUnits: "12500000",
          code: "wrong_asset",
          ruleVersion: "0.1.0",
          reviewState: "open",
        },
      },
      randomUUID(),
      now,
    );
    await expect(
      sql.begin((transaction) =>
        enqueueLifecycleEvent(transaction, exception, now),
      ),
    ).resolves.toBe(exception.id);
  });

  it("rejects noncanonical or malformed lifecycle envelopes", async () => {
    const event = invoicePaidEvent();
    const noncanonicalPayload = ` ${event.payload}`;
    await expect(
      sql.begin((transaction) =>
        enqueueLifecycleEvent(
          transaction,
          {
            ...event,
            payload: noncanonicalPayload,
            digest: createHash("sha256")
              .update(noncanonicalPayload, "utf8")
              .digest("hex"),
          },
          now,
        ),
      ),
    ).rejects.toThrow(/canonical/i);

    const malformedPayload = "[]";
    await expect(
      sql.begin((transaction) =>
        enqueueLifecycleEvent(
          transaction,
          {
            ...event,
            payload: malformedPayload,
            digest: createHash("sha256")
              .update(malformedPayload, "utf8")
              .digest("hex"),
          },
          now,
        ),
      ),
    ).rejects.toThrow(/canonical|envelope/i);

    const invalidSchemaPayload = event.payload.replace(
      '"schemaVersion": "0.1"',
      '"schemaVersion": "0.2"',
    );
    await expect(
      sql.begin((transaction) =>
        enqueueLifecycleEvent(
          transaction,
          {
            ...event,
            payload: invalidSchemaPayload,
            digest: createHash("sha256")
              .update(invalidSchemaPayload, "utf8")
              .digest("hex"),
          },
          now,
        ),
      ),
    ).rejects.toThrow(/schema/i);
  });

  it("rejects a canonical envelope with a non-RFC event UUID", async () => {
    const event = invoicePaidEvent("7f760956-98e0-42ce-acbe-969681eb3a9d");
    const invalidId = "00000000-0000-0000-0000-000000000001";
    const payload = event.payload.replace(event.id, invalidId);

    await expect(
      sql.begin((transaction) =>
        enqueueLifecycleEvent(
          transaction,
          {
            ...event,
            id: invalidId,
            payload,
            digest: createHash("sha256").update(payload, "utf8").digest("hex"),
          },
          now,
        ),
      ),
    ).rejects.toThrow(/invalid envelope schema/i);
  });

  it("protects persisted event payload bytes from mutation", async () => {
    const event = invoicePaidEvent();
    await sql.begin((transaction) =>
      enqueueLifecycleEvent(transaction, event, now),
    );
    await expect(
      sql`UPDATE webhook_events SET payload = '{}' WHERE id = ${event.id}`,
    ).rejects.toThrow(/immutable/i);
    await expect(
      sql`DELETE FROM webhook_events WHERE id = ${event.id}`,
    ).rejects.toThrow(/immutable/i);
  });

  it("participates in the caller transaction", async () => {
    const event = invoicePaidEvent();
    await expect(
      sql.begin(async (transaction) => {
        await enqueueLifecycleEvent(transaction, event, now);
        throw new Error("force rollback");
      }),
    ).rejects.toThrow("force rollback");
    await expect(store.inspectEvent(event.id)).resolves.toBeNull();
  });

  it("claims due work once across workers and records its attempt", async () => {
    await store.addEndpoint(
      {
        id: "merchant-api",
        url: "https://hooks.example.com/payops",
        secretEnv: "MERCHANT_WEBHOOK_SECRET",
      },
      now,
    );
    const event = invoicePaidEvent();
    await sql.begin((transaction) =>
      enqueueLifecycleEvent(transaction, event, now),
    );
    const otherStore = new PostgresWebhookStore({ databaseUrl });
    try {
      const claims = await Promise.all([
        store.claimDueDeliveries({ now, limit: 1, leaseMs: 30_000 }),
        otherStore.claimDueDeliveries({ now, limit: 1, leaseMs: 30_000 }),
      ]);
      expect(claims.flat()).toHaveLength(1);
      expect(claims.flat()[0]).toMatchObject({
        attemptNumber: 1,
        manualReplay: false,
        manualReplayRecovery: false,
        event: { id: event.id, payload: event.payload, digest: event.digest },
        endpoint: {
          id: "merchant-api",
          secretEnv: "MERCHANT_WEBHOOK_SECRET",
          previousSecretEnv: null,
        },
      });
      expect(claims.flat()[0]?.leaseToken).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      await expect(store.inspectEvent(event.id)).resolves.toMatchObject({
        deliveries: [
          {
            state: "in_flight",
            attemptCount: 1,
            attempts: [{ attemptNumber: 1, startedAt: now, outcome: null }],
          },
        ],
      });
    } finally {
      await otherStore.close();
    }
  });

  it("guards completion by lease token and appends attempts across replay", async () => {
    await store.addEndpoint(
      {
        id: "merchant-api",
        url: "https://hooks.example.com/payops",
        secretEnv: "MERCHANT_WEBHOOK_SECRET",
      },
      now,
    );
    const event = invoicePaidEvent();
    await sql.begin((transaction) =>
      enqueueLifecycleEvent(transaction, event, now),
    );
    const [claim] = await store.claimDueDeliveries({
      now,
      limit: 1,
      leaseMs: 30_000,
    });
    expect(claim).toBeDefined();
    await expect(
      store.completeDelivery({
        deliveryId: claim!.deliveryId,
        leaseToken: randomUUID(),
        state: "succeeded",
        completedAt: new Date("2026-08-07T10:00:01.000Z"),
        httpStatus: 204,
        errorCode: null,
        durationMs: 1000,
        nextAttemptAt: null,
      }),
    ).resolves.toBe(false);
    await expect(
      store.completeDelivery({
        deliveryId: claim!.deliveryId,
        leaseToken: claim!.leaseToken,
        state: "succeeded",
        completedAt: new Date("2026-08-07T10:00:01.000Z"),
        httpStatus: 204,
        errorCode: null,
        durationMs: 1000,
        nextAttemptAt: null,
      }),
    ).resolves.toBe(true);
    await expect(
      store.completeDelivery({
        deliveryId: claim!.deliveryId,
        leaseToken: claim!.leaseToken,
        state: "dead",
        completedAt: new Date("2026-08-07T10:00:02.000Z"),
        httpStatus: 400,
        errorCode: "http_400",
        durationMs: 1000,
        nextAttemptAt: null,
      }),
    ).resolves.toBe(false);

    await expect(
      store.replayDelivery(
        claim!.deliveryId,
        new Date("2026-08-07T10:01:00.000Z"),
      ),
    ).resolves.toBe(true);
    const [replayedClaim] = await store.claimDueDeliveries({
      now: new Date("2026-08-07T10:01:00.000Z"),
      limit: 1,
      leaseMs: 30_000,
    });
    expect(replayedClaim).toMatchObject({
      deliveryId: claim!.deliveryId,
      attemptNumber: 2,
      manualReplay: true,
      manualReplayRecovery: false,
      event: { id: event.id, payload: event.payload },
    });
    await expect(store.inspectEvent(event.id)).resolves.toMatchObject({
      payload: event.payload,
      deliveries: [
        {
          attemptCount: 2,
          attempts: [
            { attemptNumber: 1, outcome: "succeeded", httpStatus: 204 },
            { attemptNumber: 2, outcome: null },
          ],
        },
      ],
    });
  });

  it("never automatically retries a failed manual replay after the time horizon", async () => {
    await store.addEndpoint(
      {
        id: "merchant-api",
        url: "https://hooks.example.com/payops",
        secretEnv: "MERCHANT_WEBHOOK_SECRET",
      },
      now,
    );
    const event = invoicePaidEvent();
    await sql.begin((transaction) =>
      enqueueLifecycleEvent(transaction, event, now),
    );
    const [initial] = await store.claimDueDeliveries({
      now,
      limit: 1,
      leaseMs: 30_000,
    });
    await store.completeDelivery({
      deliveryId: initial!.deliveryId,
      leaseToken: initial!.leaseToken,
      state: "succeeded",
      completedAt: now,
      nextAttemptAt: null,
      httpStatus: 204,
      errorCode: null,
      durationMs: 0,
    });
    const replayAt = new Date("2026-08-11T10:00:00.000Z");
    await store.replayDelivery(initial!.deliveryId, replayAt);
    const requests: DeliveryTransportRequest[] = [];
    const transport = {
      async send(request: DeliveryTransportRequest) {
        requests.push(request);
        return { status: 500 };
      },
    };

    await expect(
      runDeliveryBatch(
        store,
        transport,
        { MERCHANT_WEBHOOK_SECRET: "manual-secret" },
        {
          limit: 1,
          leaseMs: 30_000,
          now: () => replayAt,
          random: () => 0.5,
        },
      ),
    ).resolves.toMatchObject({ dead: 1, retryScheduled: 0 });
    await expect(store.inspectEvent(event.id)).resolves.toMatchObject({
      deliveries: [
        {
          state: "dead",
          attemptCount: 2,
          nextAttemptAt: null,
          lastErrorCode: "http_500",
        },
      ],
    });
    await expect(
      runDeliveryBatch(
        store,
        transport,
        { MERCHANT_WEBHOOK_SECRET: "manual-secret" },
        {
          limit: 1,
          leaseMs: 30_000,
          now: () => new Date("2026-08-11T11:00:00.000Z"),
          random: () => 0.5,
        },
      ),
    ).resolves.toMatchObject({ claimed: 0 });
    expect(requests).toHaveLength(1);
  });

  it("terminalizes an expired manual replay lease without a network resend", async () => {
    await store.addEndpoint(
      {
        id: "merchant-api",
        url: "https://hooks.example.com/payops",
        secretEnv: "MERCHANT_WEBHOOK_SECRET",
      },
      now,
    );
    const event = invoicePaidEvent();
    await sql.begin((transaction) =>
      enqueueLifecycleEvent(transaction, event, now),
    );
    const [initial] = await store.claimDueDeliveries({
      now,
      limit: 1,
      leaseMs: 30_000,
    });
    await store.completeDelivery({
      deliveryId: initial!.deliveryId,
      leaseToken: initial!.leaseToken,
      state: "succeeded",
      completedAt: now,
      nextAttemptAt: null,
      httpStatus: 204,
      errorCode: null,
      durationMs: 0,
    });
    const replayAt = new Date("2026-08-11T10:00:00.000Z");
    await store.replayDelivery(initial!.deliveryId, replayAt);
    const [manualClaim] = await store.claimDueDeliveries({
      now: replayAt,
      limit: 1,
      leaseMs: 1,
    });
    expect(manualClaim).toMatchObject({
      manualReplay: true,
      manualReplayRecovery: false,
    });
    let sends = 0;

    await expect(
      runDeliveryBatch(
        store,
        {
          async send() {
            sends += 1;
            return { status: 204 };
          },
        },
        { MERCHANT_WEBHOOK_SECRET: "manual-secret" },
        {
          limit: 1,
          leaseMs: 30_000,
          now: () => new Date("2026-08-11T10:00:00.002Z"),
          random: () => 0.5,
        },
      ),
    ).resolves.toMatchObject({ dead: 1 });
    expect(sends).toBe(0);
    await expect(store.inspectEvent(event.id)).resolves.toMatchObject({
      deliveries: [
        {
          state: "dead",
          attemptCount: 3,
          lastErrorCode: "manual_replay_lease_expired",
          attempts: [
            { attemptNumber: 1, outcome: "succeeded" },
            { attemptNumber: 2, outcome: "abandoned" },
            {
              attemptNumber: 3,
              outcome: "dead",
              errorCode: "manual_replay_lease_expired",
            },
          ],
        },
      ],
    });
  });

  it("recovers an expired lease as the next numbered attempt", async () => {
    await store.addEndpoint(
      {
        id: "merchant-api",
        url: "https://hooks.example.com/payops",
        secretEnv: "MERCHANT_WEBHOOK_SECRET",
      },
      now,
    );
    const event = invoicePaidEvent();
    await sql.begin((transaction) =>
      enqueueLifecycleEvent(transaction, event, now),
    );
    const [first] = await store.claimDueDeliveries({
      now,
      limit: 1,
      leaseMs: 1_000,
    });
    const [second] = await store.claimDueDeliveries({
      now: new Date("2026-08-07T10:00:02.000Z"),
      limit: 1,
      leaseMs: 1_000,
    });
    expect(second).toMatchObject({
      deliveryId: first!.deliveryId,
      attemptNumber: 2,
    });
    expect(second!.leaseToken).not.toBe(first!.leaseToken);
    await expect(store.inspectEvent(event.id)).resolves.toMatchObject({
      deliveries: [
        {
          attempts: [
            { attemptNumber: 1, outcome: "abandoned" },
            { attemptNumber: 2, outcome: null },
          ],
        },
      ],
    });
  });

  it("keeps completed attempt history immutable", async () => {
    await store.addEndpoint(
      {
        id: "merchant-api",
        url: "https://hooks.example.com/payops",
        secretEnv: "MERCHANT_WEBHOOK_SECRET",
      },
      now,
    );
    const event = invoicePaidEvent();
    await sql.begin((transaction) =>
      enqueueLifecycleEvent(transaction, event, now),
    );
    const [claim] = await store.claimDueDeliveries({
      now,
      limit: 1,
      leaseMs: 30_000,
    });
    await store.completeDelivery({
      deliveryId: claim!.deliveryId,
      leaseToken: claim!.leaseToken,
      state: "succeeded",
      completedAt: new Date("2026-08-07T10:00:01.000Z"),
      httpStatus: 204,
      errorCode: null,
      durationMs: 1000,
      nextAttemptAt: null,
    });
    await expect(
      sql`
        UPDATE webhook_delivery_attempts SET outcome = 'dead'
        WHERE delivery_id = ${claim!.deliveryId} AND attempt_number = 1
      `,
    ).rejects.toThrow(/immutable/i);
    await expect(
      sql`
        DELETE FROM webhook_delivery_attempts
        WHERE delivery_id = ${claim!.deliveryId} AND attempt_number = 1
      `,
    ).rejects.toThrow(/append-only/i);
  });
});
