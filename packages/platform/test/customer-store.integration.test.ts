import { randomUUID } from "node:crypto";
import { runMigrations as runIngestionMigrations } from "@payops/ingestion";
import { runMigrations as runReconciliationMigrations } from "@payops/reconciliation";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  CustomerStore,
  OrganizationDatabase,
  runPlatformMigrations,
} from "../src/index.js";

const baseDatabaseUrl = process.env.DATABASE_URL;
const describeDatabase = baseDatabaseUrl ? describe : describe.skip;
const schema = `payops_customers_${process.pid}`;
const databaseUrl = baseDatabaseUrl
  ? withSearchPath(baseDatabaseUrl, schema)
  : undefined;
const admin = baseDatabaseUrl
  ? postgres(baseDatabaseUrl, { max: 1, onnotice: () => undefined })
  : undefined;
const firstOrganizationId = "00000000-0000-4000-8000-000000000001";
const secondOrganizationId = "00000000-0000-4000-8000-000000000002";

describeDatabase("customer store", () => {
  beforeAll(async () => {
    await admin!.unsafe(`CREATE SCHEMA ${schema}`);
  });

  beforeEach(async () => {
    await admin!.unsafe(`DROP SCHEMA ${schema} CASCADE`);
    await admin!.unsafe(`CREATE SCHEMA ${schema}`);
    await runIngestionMigrations(databaseUrl!);
    await runReconciliationMigrations(databaseUrl!);
    await runPlatformMigrations(databaseUrl!);
    const scoped = postgres(databaseUrl!, { max: 1 });
    await scoped`
      INSERT INTO organization (id, name, slug, created_at, metadata)
      VALUES (${secondOrganizationId}::uuid, 'Second', 'second', now(), '{}')
    `;
    await scoped.end();
  });

  afterAll(async () => {
    await admin!.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it("normalizes bounded fields and enforces external identity per organization", async () => {
    const database = new OrganizationDatabase(databaseUrl!, { max: 2 });
    const store = new CustomerStore(database);
    const now = new Date("2026-08-12T00:00:00.000Z");
    try {
      const created = await store.create({
        organizationId: firstOrganizationId,
        actorKind: "session",
        actorId: randomUUID(),
        externalId: "buyer-001",
        displayName: "😀".repeat(128),
        email: " Buyer@Example.COM ",
        metadata: Object.fromEntries(
          Array.from({ length: 20 }, (_, index) => [
            `key-${index}`,
            "😀".repeat(256),
          ]),
        ),
        now,
        auditRequestId: randomUUID(),
      });
      expect(created).toMatchObject({
        organizationId: firstOrganizationId,
        externalId: "buyer-001",
        email: "buyer@example.com",
      });
      await expect(
        store.create({
          organizationId: firstOrganizationId,
          actorKind: "session",
          actorId: randomUUID(),
          externalId: "buyer-001",
          displayName: "Duplicate",
          now,
        }),
      ).rejects.toMatchObject({ code: "customer_external_id_conflict" });
      await expect(
        store.create({
          organizationId: secondOrganizationId,
          actorKind: "api_key",
          actorId: randomUUID(),
          externalId: "buyer-001",
          displayName: "Other tenant",
          now,
        }),
      ).resolves.toMatchObject({ organizationId: secondOrganizationId });
    } finally {
      await database.close();
    }
  });

  it("fails closed at Unicode and metadata boundaries and keeps tenant reads opaque", async () => {
    const database = new OrganizationDatabase(databaseUrl!, { max: 2 });
    const store = new CustomerStore(database);
    const actorId = randomUUID();
    const now = new Date("2026-08-12T00:00:00.000Z");
    try {
      for (const input of [
        { displayName: "😀".repeat(129) },
        {
          displayName: "Buyer",
          metadata: Object.fromEntries(
            Array.from({ length: 21 }, (_, index) => [`key-${index}`, "value"]),
          ),
        },
        { displayName: "Buyer", metadata: { secret: "😀".repeat(257) } },
        { displayName: "Buyer", email: "not-an-email" },
      ]) {
        await expect(
          store.create({
            organizationId: firstOrganizationId,
            actorKind: "session",
            actorId,
            ...input,
            now,
          }),
        ).rejects.toMatchObject({
          code: expect.stringMatching(/^invalid_customer/),
        });
      }
      const customer = await store.create({
        organizationId: firstOrganizationId,
        actorKind: "session",
        actorId,
        displayName: "Visible only here",
        now,
      });
      await expect(
        store.get({
          organizationId: secondOrganizationId,
          actorId,
          customerId: customer.id,
        }),
      ).resolves.toBeNull();
    } finally {
      await database.close();
    }
  });

  it("orders and traverses customers by the fixed created-at and id tuple", async () => {
    const database = new OrganizationDatabase(databaseUrl!, { max: 2 });
    const store = new CustomerStore(database);
    const actorId = randomUUID();
    try {
      for (const [name, timestamp] of [
        ["First", "2026-08-12T00:00:00.000Z"],
        ["Second", "2026-08-12T00:00:01.000Z"],
        ["Third", "2026-08-12T00:00:02.000Z"],
      ] as const) {
        await store.create({
          organizationId: firstOrganizationId,
          actorKind: "session",
          actorId,
          displayName: name,
          now: new Date(timestamp),
        });
      }
      const firstPage = await store.list({
        organizationId: firstOrganizationId,
        actorId,
        limit: 2,
      });
      expect(firstPage.map((customer) => customer.displayName)).toEqual([
        "Third",
        "Second",
      ]);
      await expect(
        store.list({
          organizationId: firstOrganizationId,
          actorId,
          limit: 2,
          after: {
            createdAt: firstPage[1]!.createdAt,
            id: firstPage[1]!.id,
          },
        }),
      ).resolves.toMatchObject([{ displayName: "First" }]);
    } finally {
      await database.close();
    }
  });

  it("rolls back the domain effect when atomic idempotency completion fails", async () => {
    const database = new OrganizationDatabase(databaseUrl!, { max: 2 });
    const store = new CustomerStore(database);
    const actorId = randomUUID();
    try {
      await expect(
        store.create({
          organizationId: firstOrganizationId,
          actorKind: "session",
          actorId,
          externalId: "must-roll-back",
          displayName: "Atomic customer",
          now: new Date("2026-08-12T00:00:00.000Z"),
          idempotency: {
            complete: async () => {
              throw new Error("forced_idempotency_failure");
            },
          },
        }),
      ).rejects.toMatchObject({ code: "customer_store_unavailable" });
      await expect(
        store.list({ organizationId: firstOrganizationId, actorId, limit: 10 }),
      ).resolves.toEqual([]);
    } finally {
      await database.close();
    }
  });
});

function withSearchPath(urlString: string, schemaName: string): string {
  const url = new URL(urlString);
  url.searchParams.set("options", `-csearch_path=${schemaName}`);
  return url.toString();
}
