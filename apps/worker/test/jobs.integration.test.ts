import { runMigrations as runIngestionMigrations } from "@payops/ingestion";
import { runPlatformMigrations } from "@payops/platform";
import { runMigrations as runReconciliationMigrations } from "@payops/reconciliation";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ingestionCursorResult, selectIngestionTargets } from "../src/jobs.js";

const baseDatabaseUrl = process.env.DATABASE_URL;
const describeDatabase = baseDatabaseUrl ? describe : describe.skip;
const schema = `payops_worker_jobs_${process.pid}`;
const databaseUrl = baseDatabaseUrl
  ? withSearchPath(baseDatabaseUrl, schema)
  : undefined;
const organizationId = "00000000-0000-4000-8000-000000000001";
const admin = baseDatabaseUrl
  ? postgres(baseDatabaseUrl, { max: 1, onnotice: () => undefined })
  : undefined;
const scoped = databaseUrl
  ? postgres(withOrganization(databaseUrl, organizationId), {
      max: 1,
      onnotice: () => undefined,
    })
  : undefined;

describeDatabase("hosted worker target batching", () => {
  beforeAll(async () => {
    await admin!.unsafe(`CREATE SCHEMA ${schema}`);
    await runIngestionMigrations(databaseUrl!);
    await runReconciliationMigrations(databaseUrl!);
    await runPlatformMigrations(databaseUrl!);
    await scoped!`
      INSERT INTO rpc_providers (
        id, cluster, endpoint_env, endpoint_label, active, created_at
      ) VALUES ('provider-mainnet', 'mainnet-beta', 'TEST_RPC_URL', 'test', true, now())
    `;
    for (const [index, id] of [
      "target-001",
      "target-002",
      "target-003",
    ].entries()) {
      await scoped!`
        INSERT INTO watch_targets (
          id, provider_id, cluster, address, cutover_slot, overlap_slots,
          committed_head_slot, coverage, active, created_at, organization_id
        ) VALUES (
          ${id}, 'provider-mainnet', 'mainnet-beta',
          ${`1111111111111111111111111111111${index + 1}`}, 0, 64, 0,
          'complete', true, now(), ${organizationId}::uuid
        )
      `;
    }
  });

  afterAll(async () => {
    await scoped?.end();
    await admin!.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it("continues after the last target instead of repeating the first batch", async () => {
    const first = await selectIngestionTargets(
      scoped!,
      organizationId,
      null,
      2,
    );
    expect(first.map(({ watch_target_id }) => watch_target_id)).toEqual([
      "target-001",
      "target-002",
    ]);
    const cursor = ingestionCursorResult(
      organizationId,
      first,
      2,
      first.length,
    );
    expect(cursor).toMatchObject({
      organizationId,
      watchTargetId: "target-002",
    });

    const second = await selectIngestionTargets(
      scoped!,
      organizationId,
      String(cursor.watchTargetId),
      2,
    );
    expect(second.map(({ watch_target_id }) => watch_target_id)).toEqual([
      "target-003",
    ]);
    expect(
      ingestionCursorResult(organizationId, second, 2, second.length),
    ).toEqual({ organizations: 1, processed: 1, organizationId });
  });
});

function withSearchPath(urlString: string, schemaName: string): string {
  const url = new URL(urlString);
  url.searchParams.set("options", `-csearch_path=${schemaName}`);
  return url.toString();
}

function withOrganization(urlString: string, id: string): string {
  const url = new URL(urlString);
  const existing = url.searchParams.get("options");
  url.searchParams.set(
    "options",
    [existing, `-cpayops.organization_id=${id}`].filter(Boolean).join(" "),
  );
  return url.toString();
}
