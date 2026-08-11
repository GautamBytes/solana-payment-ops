import { randomUUID } from "node:crypto";
import { runMigrations as runIngestionMigrations } from "@payops/ingestion";
import { runMigrations as runReconciliationMigrations } from "@payops/reconciliation";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  appendAuditEvent,
  completeIdempotency,
  digestIdempotentRequest,
  IdempotencyStore,
  OrganizationDatabase,
  RateLimitStore,
  runPlatformMigrations,
} from "../src/index.js";

const baseDatabaseUrl = process.env.DATABASE_URL;
const describeDatabase = baseDatabaseUrl ? describe : describe.skip;
const schema = `payops_platform_protocol_${process.pid}`;
const databaseUrl = baseDatabaseUrl
  ? withSearchPath(baseDatabaseUrl, schema)
  : undefined;
const admin = baseDatabaseUrl
  ? postgres(baseDatabaseUrl, { max: 1, onnotice: () => undefined })
  : undefined;
const organizationId = "00000000-0000-4000-8000-000000000001";

describeDatabase("durable API protocol storage", () => {
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

  it("replays exact bytes, rejects changed requests, and recovers an expired lease", async () => {
    const database = new OrganizationDatabase(databaseUrl!, { max: 2 });
    const store = new IdempotencyStore(database, { leaseMs: 1_000 });
    const digest = digestIdempotentRequest({
      method: "POST",
      routeId: "customers.create",
      path: {},
      body: { displayName: "Acme", metadata: { b: "2", a: "1" } },
    });
    const identity = {
      organizationId,
      actorKind: "session" as const,
      actorId: randomUUID(),
      routeId: "customers.create",
      key: "customer-create-0001",
      requestDigest: digest,
    };
    const now = new Date("2026-08-12T00:00:00.000Z");
    try {
      const first = await store.claim(identity, now);
      expect(first).toMatchObject({ kind: "execute" });
      await expect(store.claim(identity, now)).resolves.toEqual({
        kind: "in_progress",
      });
      await expect(
        store.claim({ ...identity, requestDigest: "a".repeat(64) }, now),
      ).resolves.toEqual({ kind: "conflict" });

      const recovered = await store.claim(
        identity,
        new Date(now.getTime() + 1_001),
      );
      expect(recovered).toMatchObject({ kind: "execute" });
      expect(recovered).not.toEqual(first);
      if (recovered.kind !== "execute") throw new Error("expected lease");
      const responseBody = Buffer.from('{"id":"stable"}', "utf8");
      await database.transaction(
        { organizationId, actorId: identity.actorId },
        async (transaction) => {
          await completeIdempotency(transaction, {
            organizationId,
            recordId: recovered.recordId,
            leaseToken: recovered.leaseToken,
            status: 201,
            contentType: "application/json; charset=utf-8",
            body: responseBody,
            completedAt: new Date(now.getTime() + 1_100),
          });
        },
      );
      const replay = await store.claim(
        identity,
        new Date(now.getTime() + 2_000),
      );
      expect(replay).toMatchObject({
        kind: "replay",
        status: 201,
        contentType: "application/json; charset=utf-8",
      });
      if (replay.kind !== "replay") throw new Error("expected replay");
      expect(Buffer.from(replay.body).equals(responseBody)).toBe(true);
    } finally {
      await database.close();
    }
  });

  it("rolls back completion with domain work and appends immutable redacted audit", async () => {
    const database = new OrganizationDatabase(databaseUrl!, { max: 2 });
    const actorId = randomUUID();
    const requestId = randomUUID();
    try {
      await expect(
        database.transaction(
          { organizationId, actorId },
          async (transaction) => {
            await appendAuditEvent(transaction, {
              organizationId,
              actorKind: "session",
              actorId,
              action: "customer.create",
              objectKind: "customer",
              objectId: randomUUID(),
              requestId,
              ipAddress: "203.0.113.9",
              ipDigestSecret: "test-audit-secret-with-thirty-two-bytes",
              outcome: "succeeded",
              reasonCode: "created",
              occurredAt: new Date("2026-08-12T00:00:00.000Z"),
            });
            throw new Error("force rollback");
          },
        ),
      ).rejects.toThrow("force rollback");

      await database.transaction(
        { organizationId, actorId },
        async (transaction) => {
          await appendAuditEvent(transaction, {
            organizationId,
            actorKind: "session",
            actorId,
            action: "customer.create",
            objectKind: "customer",
            objectId: randomUUID(),
            requestId,
            ipAddress: "203.0.113.9",
            ipDigestSecret: "test-audit-secret-with-thirty-two-bytes",
            outcome: "succeeded",
            reasonCode: "created",
            occurredAt: new Date("2026-08-12T00:00:00.000Z"),
          });
          const rows = await transaction<
            { count: number; ip_digest: string; actor_id: string }[]
          >`
            SELECT count(*)::integer AS count, min(ip_digest) AS ip_digest,
              min(actor_id) AS actor_id
            FROM audit_events
          `;
          expect(rows).toEqual([
            {
              count: 1,
              ip_digest: expect.stringMatching(/^[0-9a-f]{64}$/),
              actor_id: actorId,
            },
          ]);
          expect(JSON.stringify(rows)).not.toContain("203.0.113.9");
        },
      );
      await expect(
        database.transaction(
          { organizationId, actorId },
          async (transaction) => {
            await transaction`DELETE FROM audit_events`;
          },
        ),
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await database.close();
    }
  });

  it("enforces a shared PostgreSQL rate limit across store instances", async () => {
    const firstDatabase = new OrganizationDatabase(databaseUrl!, { max: 1 });
    const secondDatabase = new OrganizationDatabase(databaseUrl!, { max: 1 });
    const first = new RateLimitStore(firstDatabase, {
      limit: 2,
      windowSeconds: 60,
    });
    const second = new RateLimitStore(secondDatabase, {
      limit: 2,
      windowSeconds: 60,
    });
    const input = {
      organizationId,
      actorKind: "api_key" as const,
      actorId: randomUUID(),
      routeGroup: "merchant.write",
      now: new Date("2026-08-12T00:00:30.000Z"),
    };
    try {
      await expect(first.consume(input)).resolves.toMatchObject({
        allowed: true,
        remaining: 1,
      });
      await expect(second.consume(input)).resolves.toMatchObject({
        allowed: true,
        remaining: 0,
      });
      await expect(first.consume(input)).resolves.toMatchObject({
        allowed: false,
        retryAfterSeconds: 30,
      });
      await expect(
        second.consume({ ...input, now: new Date("2026-08-12T00:01:00.000Z") }),
      ).resolves.toMatchObject({ allowed: true, remaining: 1 });
    } finally {
      await Promise.all([firstDatabase.close(), secondDatabase.close()]);
    }
  });
});

function withSearchPath(urlString: string, schemaName: string): string {
  const url = new URL(urlString);
  url.searchParams.set("options", `-csearch_path=${schemaName}`);
  return url.toString();
}
