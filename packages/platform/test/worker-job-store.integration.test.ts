import { runMigrations as runIngestionMigrations } from "@payops/ingestion";
import { runMigrations as runReconciliationMigrations } from "@payops/reconciliation";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runPlatformMigrations, WorkerJobStore } from "../src/index.js";

const baseDatabaseUrl = process.env.DATABASE_URL;
const describeDatabase = baseDatabaseUrl ? describe : describe.skip;
const schema = `payops_worker_jobs_${process.pid}`;
const databaseUrl = baseDatabaseUrl
  ? withSearchPath(baseDatabaseUrl, schema)
  : undefined;
const admin = baseDatabaseUrl
  ? postgres(baseDatabaseUrl, { max: 1, onnotice: () => undefined })
  : undefined;

describeDatabase("worker job leases", () => {
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

  it("prevents overlap, rejects stale completion, and reclaims an expired lease", async () => {
    const first = new WorkerJobStore(databaseUrl!);
    const second = new WorkerJobStore(databaseUrl!);
    try {
      await first.assertReady();
      const now = new Date("2026-08-12T12:00:00.000Z");
      const lease = await first.claim({
        name: "project_payment_status",
        now,
        leaseMs: 5_000,
      });
      expect(lease).not.toBeNull();
      await expect(
        second.claim({
          name: "project_payment_status",
          now,
          leaseMs: 5_000,
        }),
      ).resolves.toBeNull();
      const replacement = await second.claim({
        name: "project_payment_status",
        now: new Date("2026-08-12T12:00:05.000Z"),
        leaseMs: 5_000,
      });
      expect(replacement).not.toBeNull();
      await expect(
        first.complete({ lease: lease!, now, cursor: { examined: 1 } }),
      ).resolves.toBe(false);
      await expect(
        second.complete({
          lease: replacement!,
          now: new Date("2026-08-12T12:00:06.000Z"),
          cursor: { examined: 2 },
        }),
      ).resolves.toBe(true);
      const cursorLease = await first.claim({
        name: "project_payment_status",
        now: new Date("2026-08-12T12:00:07.000Z"),
        leaseMs: 5_000,
      });
      expect(cursorLease?.cursor).toEqual({ examined: 2 });
      await expect(
        first.renew({
          lease: cursorLease!,
          now: new Date("2026-08-12T12:00:08.000Z"),
          leaseMs: 10_000,
        }),
      ).resolves.toMatchObject({
        expiresAt: new Date("2026-08-12T12:00:18.000Z"),
      });
    } finally {
      await first.close();
      await second.close();
    }
  });

  it("records only bounded error codes and releases an owned lease", async () => {
    const store = new WorkerJobStore(databaseUrl!);
    try {
      const now = new Date("2026-08-12T12:00:00.000Z");
      const lease = await store.claim({
        name: "send_webhooks",
        now,
        leaseMs: 5_000,
      });
      await expect(
        store.complete({
          lease: lease!,
          now,
          errorCode: "database_unavailable",
        }),
      ).resolves.toBe(true);
      const next = await store.claim({
        name: "send_webhooks",
        now,
        leaseMs: 5_000,
      });
      await expect(store.release(next!, now)).resolves.toBe(true);
      await expect(
        store.complete({ lease: next!, now, errorCode: "unsafe message!" }),
      ).rejects.toThrow("error code");
    } finally {
      await store.close();
    }
  });
});

function withSearchPath(urlString: string, schemaName: string): string {
  const url = new URL(urlString);
  url.searchParams.set("options", `-csearch_path=${schemaName}`);
  return url.toString();
}
