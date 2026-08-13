import { runMigrations as runIngestionMigrations } from "@payops/ingestion";
import { runMigrations as runReconciliationMigrations } from "@payops/reconciliation";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  WORKER_JOB_NAMES,
  WorkerJobStore,
  type WorkerJobName,
} from "../src/index.js";
import {
  cleanupTestProductionRoles,
  runTestPlatformMigrations,
} from "./production-role-test-helper.js";

const baseDatabaseUrl = process.env.DATABASE_URL;
const describeDatabase = baseDatabaseUrl ? describe : describe.skip;
const schema = `payops_worker_jobs_${process.pid}`;
const databaseUrl = baseDatabaseUrl
  ? withSearchPath(baseDatabaseUrl, schema)
  : undefined;
const admin = baseDatabaseUrl
  ? postgres(baseDatabaseUrl, { max: 1, onnotice: () => undefined })
  : undefined;
const scoped = databaseUrl
  ? postgres(databaseUrl, { max: 1, onnotice: () => undefined })
  : undefined;
const testRpc = {
  mode: "single_provider" as const,
  cluster: "localnet" as const,
  primaryProviderId: "test-provider",
  primaryEndpointEnvironment: "TEST_RPC_URL",
  primaryEndpointDigest: "a".repeat(64),
  secondaryProviderId: null,
  secondaryEndpointEnvironment: null,
  secondaryEndpointDigest: null,
};

describeDatabase("worker job leases", () => {
  beforeAll(async () => {
    await admin!.unsafe(`CREATE SCHEMA ${schema}`);
  });
  beforeEach(async () => {
    await admin!.unsafe(`DROP SCHEMA ${schema} CASCADE`);
    await admin!.unsafe(`CREATE SCHEMA ${schema}`);
    await runIngestionMigrations(databaseUrl!);
    await runReconciliationMigrations(databaseUrl!);
    await runTestPlatformMigrations(databaseUrl!);
  });
  afterAll(async () => {
    await scoped?.end();
    await admin!.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await cleanupTestProductionRoles(databaseUrl!);
    await admin?.end();
  });

  it("prevents overlap, rejects stale completion, and reclaims an expired lease", async () => {
    const first = new WorkerJobStore(databaseUrl!);
    const second = new WorkerJobStore(databaseUrl!);
    try {
      await first.assertReady();
      const firstInstance = await first.startInstance({
        buildRevision: "test-first",
        rpc: testRpc,
      });
      const secondInstance = await second.startInstance({
        buildRevision: "test-second",
        rpc: testRpc,
      });
      const now = new Date("2026-08-12T12:00:00.000Z");
      const lease = await first.claim({
        instanceId: firstInstance.id,
        name: "project_payment_status",
        now,
        intervalMs: 2_000,
        leaseMs: 5_000,
      });
      expect(lease).not.toBeNull();
      await expect(
        second.claim({
          instanceId: secondInstance.id,
          name: "project_payment_status",
          now,
          intervalMs: 2_000,
          leaseMs: 5_000,
        }),
      ).resolves.toBeNull();
      await scoped!`
        UPDATE worker_job_states
        SET lease_expires_at = clock_timestamp() - interval '1 second'
        WHERE name = 'project_payment_status'
      `;
      const replacement = await second.claim({
        instanceId: secondInstance.id,
        name: "project_payment_status",
        now: new Date("2026-08-12T12:00:05.000Z"),
        intervalMs: 2_000,
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
        instanceId: firstInstance.id,
        name: "project_payment_status",
        now: new Date("2026-08-12T12:00:07.000Z"),
        intervalMs: 2_000,
        leaseMs: 5_000,
      });
      expect(cursorLease?.cursor).toEqual({ examined: 2 });
      const beforeRenew = Date.now();
      const renewed = await first.renew({
        lease: cursorLease!,
        now: new Date("2026-08-12T12:00:08.000Z"),
        leaseMs: 10_000,
      });
      expect(renewed!.expiresAt.getTime()).toBeGreaterThanOrEqual(
        beforeRenew + 9_000,
      );
      expect(renewed!.expiresAt.getTime()).toBeLessThanOrEqual(
        Date.now() + 11_000,
      );
    } finally {
      await first.close();
      await second.close();
    }
  });

  it("uses the PostgreSQL clock for claim, renewal, and expiry despite extreme caller skew", async () => {
    const first = new WorkerJobStore(databaseUrl!);
    const second = new WorkerJobStore(databaseUrl!);
    try {
      const firstInstance = await first.startInstance({
        buildRevision: "clock-first",
        rpc: testRpc,
      });
      const secondInstance = await second.startInstance({
        buildRevision: "clock-second",
        rpc: testRpc,
      });
      const beforeClaim = Date.now();
      const lease = await first.claim({
        instanceId: firstInstance.id,
        name: "project_payment_status",
        now: new Date("1900-01-01T00:00:00.000Z"),
        intervalMs: 2_000,
        leaseMs: 5_000,
      });
      expect(lease).not.toBeNull();
      expect(lease!.expiresAt.getTime()).toBeGreaterThanOrEqual(
        beforeClaim + 4_000,
      );
      expect(lease!.expiresAt.getTime()).toBeLessThanOrEqual(
        Date.now() + 6_000,
      );

      await expect(
        second.claim({
          instanceId: secondInstance.id,
          name: "project_payment_status",
          now: new Date("2999-01-01T00:00:00.000Z"),
          intervalMs: 2_000,
          leaseMs: 5_000,
        }),
      ).resolves.toBeNull();

      const beforeRenew = Date.now();
      const renewed = await first.renew({
        lease: lease!,
        now: new Date("2999-01-01T00:00:00.000Z"),
        leaseMs: 10_000,
      });
      expect(renewed).not.toBeNull();
      expect(renewed!.expiresAt.getTime()).toBeGreaterThanOrEqual(
        beforeRenew + 9_000,
      );
      expect(renewed!.expiresAt.getTime()).toBeLessThanOrEqual(
        Date.now() + 11_000,
      );

      await scoped!`
        UPDATE worker_job_states
        SET lease_expires_at = clock_timestamp() - interval '1 second'
        WHERE name = 'project_payment_status'
      `;
      await expect(
        second.claim({
          instanceId: secondInstance.id,
          name: "project_payment_status",
          now: new Date("1900-01-01T00:00:00.000Z"),
          intervalMs: 2_000,
          leaseMs: 5_000,
        }),
      ).resolves.toMatchObject({ instanceId: secondInstance.id });
    } finally {
      await first.close();
      await second.close();
    }
  });

  it("fences completion after the database lease deadline", async () => {
    const first = new WorkerJobStore(databaseUrl!);
    const second = new WorkerJobStore(databaseUrl!);
    try {
      const firstInstance = await first.startInstance({
        buildRevision: "expired-completer",
        rpc: testRpc,
      });
      const secondInstance = await second.startInstance({
        buildRevision: "replacement-owner",
        rpc: testRpc,
      });
      const expired = await first.claim({
        instanceId: firstInstance.id,
        name: "project_payment_status",
        now: new Date(),
        intervalMs: 2_000,
        leaseMs: 5_000,
      });
      await scoped!`
        UPDATE worker_job_states
        SET lease_expires_at = clock_timestamp() - interval '1 second'
        WHERE name = 'project_payment_status'
      `;

      await expect(
        first.complete({
          lease: expired!,
          now: new Date(),
          cursor: { stale: true },
        }),
      ).resolves.toBe(false);
      const replacement = await second.claim({
        instanceId: secondInstance.id,
        name: "project_payment_status",
        now: new Date(),
        intervalMs: 2_000,
        leaseMs: 5_000,
      });
      expect(replacement).not.toBeNull();
      await expect(
        first.complete({
          lease: expired!,
          now: new Date(),
          cursor: { stale: true },
        }),
      ).resolves.toBe(false);
      await expect(scoped!`
        SELECT lease_owner_id::text AS owner, cursor
        FROM worker_job_states WHERE name = 'project_payment_status'
      `).resolves.toEqual([{ owner: secondInstance.id, cursor: {} }]);
    } finally {
      await first.close();
      await second.close();
    }
  });

  it("records only bounded error codes and releases an owned lease", async () => {
    const store = new WorkerJobStore(databaseUrl!);
    try {
      const instance = await store.startInstance({
        buildRevision: "test",
        rpc: testRpc,
      });
      const now = new Date("2026-08-12T12:00:00.000Z");
      const lease = await store.claim({
        instanceId: instance.id,
        name: "send_webhooks",
        now,
        intervalMs: 2_000,
        leaseMs: 5_000,
      });
      await expect(
        store.complete({
          lease: lease!,
          now,
          failureClass: "dependency",
        }),
      ).resolves.toBe(true);
      const next = await store.claim({
        instanceId: instance.id,
        name: "send_webhooks",
        now,
        intervalMs: 2_000,
        leaseMs: 5_000,
      });
      await scoped!`
        UPDATE worker_instances
        SET started_at = clock_timestamp() - interval '3 minutes',
          last_heartbeat_at = clock_timestamp() - interval '2 minutes'
        WHERE id = ${instance.id}::uuid
      `;
      await expect(store.release(next!, now)).resolves.toBe(true);
      await expect(
        scoped!<{ fresh: boolean }[]>`
          SELECT last_heartbeat_at >= clock_timestamp() - interval '5 seconds'
            AS fresh
          FROM worker_instances WHERE id = ${instance.id}::uuid
        `,
      ).resolves.toEqual([{ fresh: true }]);
      await expect(
        store.complete({
          lease: next!,
          now,
          failureClass: "unsafe_message" as "dependency",
        }),
      ).rejects.toThrow("failure class");
    } finally {
      await store.close();
    }
  });

  it("persists bounded lifecycle and job outcome facts without false success", async () => {
    const store = new WorkerJobStore(databaseUrl!);
    try {
      const instance = await store.startInstance({
        buildRevision: "release-2026-08-13",
        rpc: testRpc,
      });
      const started = await scoped!<
        { state: string; build_revision: string; heartbeat: boolean }[]
      >`
        SELECT state, build_revision,
          last_heartbeat_at >= started_at AS heartbeat
        FROM worker_instances WHERE id = ${instance.id}::uuid
      `;
      expect(started).toEqual([
        {
          state: "running",
          build_revision: "release-2026-08-13",
          heartbeat: true,
        },
      ]);

      const firstLease = await store.claim({
        instanceId: instance.id,
        name: "verify_rpc_consensus",
        now: new Date(),
        intervalMs: 7_000,
        leaseMs: 5_000,
      });
      await expect(
        store.complete({
          lease: firstLease!,
          now: new Date(),
          cursor: { verified: 1 },
        }),
      ).resolves.toBe(true);
      const secondLease = await store.claim({
        instanceId: instance.id,
        name: "verify_rpc_consensus",
        now: new Date(Date.now() + 6_000),
        intervalMs: 7_000,
        leaseMs: 5_000,
      });
      await expect(
        store.complete({
          lease: secondLease!,
          now: new Date(Date.now() + 6_100),
          failureClass: "dependency",
        }),
      ).resolves.toBe(true);

      const facts = await scoped!<
        {
          attempts: number;
          successes: number;
          failures: number;
          consecutive_failures: number;
          last_failure_class: string;
          interval_ms: number;
        }[]
      >`
        SELECT attempts, successes, failures, consecutive_failures,
          last_failure_class, interval_ms
        FROM worker_job_states WHERE name = 'verify_rpc_consensus'
      `;
      expect(facts).toEqual([
        {
          attempts: 2,
          successes: 1,
          failures: 1,
          consecutive_failures: 1,
          last_failure_class: "dependency",
          interval_ms: 7_000,
        },
      ]);

      await expect(store.drainInstance(instance.id)).resolves.toBe(true);
      await expect(
        store.claim({
          instanceId: instance.id,
          name: "verify_rpc_consensus",
          now: new Date(Date.now() + 7_000),
          intervalMs: 7_000,
          leaseMs: 5_000,
        }),
      ).resolves.toBeNull();
      await expect(store.stopInstance(instance.id)).resolves.toBe(true);
      await expect(store.heartbeat(instance.id)).resolves.toBe(false);
    } finally {
      await store.close();
    }
  });

  it("fails readiness closed for stale heartbeat and missing required attempts", async () => {
    const store = new WorkerJobStore(databaseUrl!);
    try {
      const instance = await store.startInstance({
        buildRevision: "test",
        rpc: testRpc,
      });
      const initial = await store.readiness();
      expect(initial.ready).toBe(false);
      expect(initial.requiredJobs).toHaveLength(6);
      expect(initial.requiredJobs.map(({ name }) => name)).not.toContain(
        "reconcile_attempts",
      );

      await scoped!`
        UPDATE worker_instances
        SET started_at = clock_timestamp() - interval '3 minutes',
          last_heartbeat_at = clock_timestamp() - interval '2 minutes'
        WHERE id = ${instance.id}::uuid
      `;
      const stale = await store.readiness();
      expect(stale).toMatchObject({ ready: false, activeWorkers: 0 });
    } finally {
      await store.close();
    }
  });

  it("requires the legacy reconciliation job to be explicitly retired", async () => {
    const store = new WorkerJobStore(databaseUrl!);
    try {
      await expect(
        scoped!<{ name: string; lifecycle: string }[]>`
          SELECT name, lifecycle FROM worker_job_states ORDER BY name
        `,
      ).resolves.toEqual([
        { name: "expire_quotes", lifecycle: "active" },
        { name: "ingest_watch_targets", lifecycle: "active" },
        { name: "project_payment_status", lifecycle: "active" },
        { name: "reconcile_attempts", lifecycle: "retired" },
        { name: "refresh_finality", lifecycle: "active" },
        { name: "send_webhooks", lifecycle: "active" },
        { name: "verify_rpc_consensus", lifecycle: "active" },
      ]);
      await expect(store.assertReady()).resolves.toBeUndefined();
      await expect(
        scoped!`
          UPDATE worker_job_states
          SET lease_token = gen_random_uuid(),
            lease_expires_at = clock_timestamp() + interval '1 minute',
            last_started_at = clock_timestamp(), updated_at = clock_timestamp()
          WHERE name = 'reconcile_attempts' AND lease_token IS NULL
        `,
      ).rejects.toThrow();
      await expect(
        store.claim({
          instanceId: "00000000-0000-4000-8000-000000000001",
          name: "reconcile_attempts" as WorkerJobName,
          now: new Date(),
          intervalMs: 2_000,
          leaseMs: 5_000,
        }),
      ).rejects.toThrow("job name");

      await expect(
        scoped!`
          UPDATE worker_job_states SET lifecycle = 'active'
          WHERE name = 'reconcile_attempts'
        `,
      ).rejects.toThrow();
      await expect(store.assertReady()).resolves.toBeUndefined();
    } finally {
      await store.close();
    }
  });

  it("binds shared-database readiness to the exact worker RPC mode and provider pair", async () => {
    const store = new WorkerJobStore(databaseUrl!);
    const productionRpc = {
      mode: "dual_provider" as const,
      cluster: "mainnet-beta" as const,
      primaryProviderId: "provider-mainnet",
      primaryEndpointEnvironment: "PRIMARY_RPC",
      primaryEndpointDigest: "a".repeat(64),
      secondaryProviderId: "provider-secondary",
      secondaryEndpointEnvironment: "SECONDARY_RPC",
      secondaryEndpointDigest: "b".repeat(64),
    };
    try {
      const single = await store.startInstance({
        buildRevision: "single-worker",
        rpc: {
          ...testRpc,
          mode: "single_provider",
          cluster: "mainnet-beta",
          primaryProviderId: "provider-mainnet",
        },
      });
      await recordSuccessfulCycle(store, single.id);
      await expect(
        store.readiness({ rpc: productionRpc }),
      ).resolves.toMatchObject({ ready: false, activeWorkers: 0 });

      const production = await store.startInstance({
        buildRevision: "production-worker",
        rpc: productionRpc,
      });
      await recordSuccessfulCycle(store, production.id);
      await expect(
        store.readiness({ rpc: productionRpc }),
      ).resolves.toMatchObject({ ready: true, activeWorkers: 1 });

      await expect(
        store.readiness({
          rpc: {
            ...productionRpc,
            primaryEndpointDigest: "f".repeat(64),
          },
        }),
      ).resolves.toMatchObject({ ready: false, activeWorkers: 0 });

      const mismatch = await store.startInstance({
        buildRevision: "mismatch-worker",
        rpc: {
          ...productionRpc,
          secondaryProviderId: "provider-other",
        },
      });

      const mismatchedLease = await store.claim({
        instanceId: mismatch.id,
        name: "project_payment_status",
        now: new Date(),
        intervalMs: 2_000,
        leaseMs: 5_000,
      });
      expect(mismatchedLease).not.toBeNull();
      await expect(
        store.readiness({ rpc: productionRpc }),
      ).resolves.toMatchObject({ ready: false, activeWorkers: 1 });

      await expect(
        store.complete({
          lease: mismatchedLease!,
          now: new Date(),
          failureClass: "dependency",
        }),
      ).resolves.toBe(true);
      await expect(
        store.readiness({ rpc: productionRpc }),
      ).resolves.toMatchObject({ ready: false, activeWorkers: 1 });

      await recordSuccessfulCycle(store, mismatch.id);
      await expect(
        store.readiness({ rpc: productionRpc }),
      ).resolves.toMatchObject({ ready: false, activeWorkers: 1 });
    } finally {
      await store.close();
    }
  });

  it("rejects stale matching latest-attempt and active-lease owners", async () => {
    const store = new WorkerJobStore(databaseUrl!);
    try {
      const successful = await store.startInstance({
        buildRevision: "successful-worker",
        rpc: testRpc,
      });
      await recordSuccessfulCycle(store, successful.id);
      await expect(store.readiness({ rpc: testRpc })).resolves.toMatchObject({
        ready: true,
      });

      const stale = await store.startInstance({
        buildRevision: "stale-attempt-worker",
        rpc: testRpc,
      });
      const staleLease = await store.claim({
        instanceId: stale.id,
        name: "project_payment_status",
        now: new Date(),
        intervalMs: 2_000,
        leaseMs: 5_000,
      });
      await scoped!`
        UPDATE worker_instances
        SET started_at = clock_timestamp() - interval '3 minutes',
          last_heartbeat_at = clock_timestamp() - interval '2 minutes'
        WHERE id = ${stale.id}::uuid
      `;

      await expect(store.readiness({ rpc: testRpc })).resolves.toMatchObject({
        ready: false,
      });
      await scoped!`
        UPDATE worker_job_states
        SET lease_token = NULL, lease_expires_at = NULL, lease_owner_id = NULL,
          last_completed_at = clock_timestamp()
        WHERE name = ${staleLease!.name}
      `;
      await expect(store.readiness({ rpc: testRpc })).resolves.toMatchObject({
        ready: false,
      });
    } finally {
      await store.close();
    }
  });

  it("fails readiness closed for an active legacy lease without an owner", async () => {
    const store = new WorkerJobStore(databaseUrl!);
    const productionRpc = {
      mode: "dual_provider" as const,
      cluster: "mainnet-beta" as const,
      primaryProviderId: "provider-mainnet",
      primaryEndpointEnvironment: "PRIMARY_RPC",
      primaryEndpointDigest: "a".repeat(64),
      secondaryProviderId: "provider-secondary",
      secondaryEndpointEnvironment: "SECONDARY_RPC",
      secondaryEndpointDigest: "b".repeat(64),
    };
    try {
      const production = await store.startInstance({
        buildRevision: "production-worker",
        rpc: productionRpc,
      });
      await recordSuccessfulCycle(store, production.id);
      await expect(
        store.readiness({ rpc: productionRpc }),
      ).resolves.toMatchObject({ ready: true, activeWorkers: 1 });

      await scoped!`
        UPDATE worker_job_states
        SET lease_token = gen_random_uuid(),
          lease_expires_at = clock_timestamp() + interval '1 minute',
          lease_owner_id = NULL
        WHERE name = 'project_payment_status'
      `;
      await expect(
        store.readiness({ rpc: productionRpc }),
      ).resolves.toMatchObject({ ready: false, activeWorkers: 1 });
    } finally {
      await store.close();
    }
  });
});

async function recordSuccessfulCycle(
  store: WorkerJobStore,
  instanceId: string,
): Promise<void> {
  for (const name of WORKER_JOB_NAMES) {
    const lease = await store.claim({
      instanceId,
      name,
      now: new Date(),
      intervalMs: 2_000,
      leaseMs: 5_000,
    });
    expect(lease).not.toBeNull();
    await expect(
      store.complete({ lease: lease!, now: new Date(), cursor: {} }),
    ).resolves.toBe(true);
  }
}

function withSearchPath(urlString: string, schemaName: string): string {
  const url = new URL(urlString);
  url.searchParams.set("options", `-csearch_path=${schemaName}`);
  return url.toString();
}
