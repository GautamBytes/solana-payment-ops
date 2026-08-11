import { createHash, randomUUID } from "node:crypto";
import { stringifyCanonical } from "@payops/core";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runPilotMigrations } from "../src/storage/migrate.js";
import { PostgresPilotStore } from "../src/storage/postgres-pilot-store.js";

const baseDatabaseUrl =
  process.env.DATABASE_URL ??
  "postgres://payops:payops@127.0.0.1:55432/payops_test";
const schema = `pilot_store_${randomUUID().replaceAll("-", "")}`;
const databaseUrl = databaseUrlForSchema(baseDatabaseUrl, schema);
const adminSql = postgres(baseDatabaseUrl, {
  max: 1,
  onnotice: () => undefined,
});
const sql = postgres(databaseUrl, { max: 4 });
const startedAt = new Date("2026-08-11T10:00:00.000Z");
let store: PostgresPilotStore;

beforeAll(async () => {
  await adminSql.unsafe(`CREATE SCHEMA ${schema}`);
  await runPilotMigrations(databaseUrl);
  await runPilotMigrations(databaseUrl);
});

beforeEach(async () => {
  await store?.close();
  await sql`TRUNCATE pilot_reports, pilot_run_stages, pilot_runs CASCADE`;
  store = new PostgresPilotStore({ databaseUrl });
});

afterAll(async () => {
  await store?.close();
  await sql.end();
  await adminSql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await adminSql.end();
});

describe("PostgresPilotStore", () => {
  it("creates one run and six ordered stages per manifest", async () => {
    const first = await store.getOrCreateRun(runInput());
    const second = await store.getOrCreateRun(runInput());

    expect(second).toEqual(first);
    await expect(stageRows(first.id)).resolves.toEqual([
      ["configure", 1, "pending"],
      ["import_invoices", 2, "pending"],
      ["sync", 3, "pending"],
      ["finality", 4, "pending"],
      ["reconcile", 5, "pending"],
      ["report", 6, "pending"],
    ]);
  });

  it("creates a new run when the manifest digest changes", async () => {
    const first = await store.getOrCreateRun(runInput());
    const second = await store.getOrCreateRun(
      runInput({ manifestBody: stringifyCanonical({ v: 2 }) }),
    );

    expect(second.id).not.toBe(first.id);
    await expect(
      sql<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM pilot_runs
      `,
    ).resolves.toEqual([{ count: 2 }]);
  });

  it("refuses a digest collision with different canonical input", async () => {
    const original = runInput();
    await store.getOrCreateRun(original);

    await expect(
      store.getOrCreateRun(
        runInput({
          manifestBody: stringifyCanonical({ poison: true }),
          manifestDigest: original.manifestDigest,
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_configuration" });
  });

  it("claims only the next stage and skips a completed stage", async () => {
    const run = await store.getOrCreateRun(runInput());
    const configure = await store.claimStage({ runId: run.id, now: startedAt });

    expect(configure).toMatchObject({ stage: "configure", ordinal: 1 });
    await expect(
      store.claimStage({ runId: run.id, now: startedAt }),
    ).resolves.toBeNull();
    await expect(
      store.completeStage({
        runId: run.id,
        stage: "configure",
        leaseToken: configure!.leaseToken,
        result: { providers: 1, watches: 1 },
        completedAt: startedAt,
      }),
    ).resolves.toBe(true);

    await expect(
      store.claimStage({ runId: run.id, now: startedAt }),
    ).resolves.toMatchObject({ stage: "import_invoices", ordinal: 2 });
  });

  it("allows only one concurrent claim", async () => {
    const run = await store.getOrCreateRun(runInput());
    const other = new PostgresPilotStore({ databaseUrl });
    try {
      const claims = await Promise.all([
        store.claimStage({ runId: run.id, now: startedAt }),
        other.claimStage({ runId: run.id, now: startedAt }),
      ]);

      expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
    } finally {
      await other.close();
    }
  });

  it("reclaims an expired lease and rejects the stale token", async () => {
    const run = await store.getOrCreateRun(runInput());
    const first = await store.claimStage({ runId: run.id, now: startedAt });
    const reclaimedAt = new Date(startedAt.getTime() + 15 * 60_000 + 1);
    const second = await store.claimStage({ runId: run.id, now: reclaimedAt });

    expect(second?.leaseToken).not.toBe(first?.leaseToken);
    await expect(
      store.completeStage({
        runId: run.id,
        stage: "configure",
        leaseToken: first!.leaseToken,
        result: { stale: true },
        completedAt: reclaimedAt,
      }),
    ).resolves.toBe(false);
    await expect(
      store.completeStage({
        runId: run.id,
        stage: "configure",
        leaseToken: second!.leaseToken,
        result: { ok: true },
        completedAt: reclaimedAt,
      }),
    ).resolves.toBe(true);
  });

  it("persists a bounded failure and allows its stage to be retried", async () => {
    const run = await store.getOrCreateRun(runInput());
    const claim = await store.claimStage({ runId: run.id, now: startedAt });

    await expect(
      store.failStage({
        runId: run.id,
        stage: "configure",
        leaseToken: claim!.leaseToken,
        errorCode: "invalid_configuration",
        failedAt: startedAt,
      }),
    ).resolves.toBe(true);
    await expect(
      store.claimStage({ runId: run.id, now: startedAt }),
    ).resolves.toMatchObject({ stage: "configure" });
  });

  it("makes succeeded stage evidence immutable", async () => {
    const run = await store.getOrCreateRun(runInput());
    const claim = await store.claimStage({ runId: run.id, now: startedAt });
    await store.completeStage({
      runId: run.id,
      stage: "configure",
      leaseToken: claim!.leaseToken,
      result: { ok: true },
      completedAt: startedAt,
    });

    await expect(
      sql`UPDATE pilot_run_stages SET result = '{"poison":true}' WHERE run_id = ${run.id}`,
    ).rejects.toThrow(/immutable/i);
    await expect(
      sql`DELETE FROM pilot_run_stages WHERE run_id = ${run.id}`,
    ).rejects.toThrow(/immutable/i);
  });

  it("records report metadata idempotently and rejects conflicts", async () => {
    const run = await store.getOrCreateRun(runInput());
    const report = {
      runId: run.id,
      audience: "private" as const,
      format: "json" as const,
      contentDigest: "c".repeat(64),
      byteLength: 123,
      createdAt: startedAt,
    };

    await store.recordReport(report);
    await expect(store.recordReport(report)).resolves.toBeUndefined();
    await expect(
      store.recordReport({ ...report, contentDigest: "d".repeat(64) }),
    ).rejects.toMatchObject({ code: "invalid_configuration" });
    await expect(
      sql`UPDATE pilot_reports SET byte_length = 1 WHERE run_id = ${run.id}`,
    ).rejects.toThrow(/immutable/i);
    await expect(
      sql`DELETE FROM pilot_reports WHERE run_id = ${run.id}`,
    ).rejects.toThrow(/immutable/i);
  });

  it("returns a secret-safe run inspection", async () => {
    const run = await store.getOrCreateRun(
      runInput({
        manifestBody: stringifyCanonical({ endpointEnv: "VERY_SECRET_ENV" }),
      }),
    );

    const inspection = await store.getRun(run.id);
    const serialized = JSON.stringify(inspection);

    expect(inspection).toMatchObject({
      id: run.id,
      pilotId: run.pilotId,
      manifestDigest: run.manifestDigest,
      state: "running",
    });
    expect(inspection?.stages).toHaveLength(6);
    expect(serialized).not.toContain("VERY_SECRET_ENV");
    expect(serialized).not.toContain("manifestBody");
  });

  it("fails closed for a hostile date without touching the database", async () => {
    const hostile = new Proxy(new Date(), {
      getPrototypeOf: () => {
        throw new Error("hostile prototype");
      },
    });

    await expect(
      store.getOrCreateRun(
        runInput({ startedAt: hostile }) as Parameters<
          PostgresPilotStore["getOrCreateRun"]
        >[0],
      ),
    ).rejects.toMatchObject({ code: "invalid_configuration" });
    await expect(
      sql<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM pilot_runs
      `,
    ).resolves.toEqual([{ count: 0 }]);
  });

  it("refuses to finish a run before every stage succeeds", async () => {
    const run = await store.getOrCreateRun(runInput());

    await expect(
      store.finishRun({
        runId: run.id,
        state: "complete",
        completedAt: startedAt,
      }),
    ).resolves.toBe(false);
    await expect(store.getRun(run.id)).resolves.toMatchObject({
      state: "running",
      completedAt: null,
    });
  });
});

function runInput(overrides: Record<string, unknown> = {}) {
  const manifestBody =
    typeof overrides.manifestBody === "string"
      ? overrides.manifestBody
      : stringifyCanonical({ schemaVersion: "0.1" });
  const manifestDigest =
    typeof overrides.manifestDigest === "string"
      ? overrides.manifestDigest
      : createHash("sha256").update(manifestBody, "utf8").digest("hex");
  return {
    pilotId: "651cd115-6ad8-46e8-9368-6078b1620f24",
    manifestDigest,
    manifestBody,
    invoiceDigest: "f".repeat(64),
    startedAt,
    ...overrides,
  };
}

async function stageRows(
  runId: string,
): Promise<readonly [string, number, string][]> {
  const rows = await sql<{ stage: string; ordinal: number; state: string }[]>`
    SELECT stage, ordinal, state
    FROM pilot_run_stages
    WHERE run_id = ${runId}
    ORDER BY ordinal
  `;
  return rows.map(({ stage, ordinal, state }) => [stage, ordinal, state]);
}

function databaseUrlForSchema(databaseUrl: string, schemaName: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set("options", `-csearch_path=${schemaName}`);
  return url.toString();
}
