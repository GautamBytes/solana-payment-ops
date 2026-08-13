import { randomUUID } from "node:crypto";
import {
  PostgresIngestionStore,
  runMigrations as runIngestionMigrations,
  type FinalizedProviderObservation,
} from "@payops/ingestion";
import { runMigrations as runReconciliationMigrations } from "@payops/reconciliation";
import {
  PostgresWebhookStore,
  runMigrations as runWebhookMigrations,
} from "@payops/webhooks";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  LedgerStore,
  OperationalHealthStore,
  OrganizationDatabase,
} from "../src/index.js";
import {
  cleanupTestProductionRoles,
  runTestPlatformMigrations,
} from "./production-role-test-helper.js";

const baseDatabaseUrl = process.env.DATABASE_URL;
const describeDatabase = baseDatabaseUrl ? describe : describe.skip;
const schema = `payops_health_producers_${process.pid}`;
const databaseUrl = baseDatabaseUrl
  ? withSearchPath(baseDatabaseUrl, schema)
  : undefined;
const admin = baseDatabaseUrl
  ? postgres(baseDatabaseUrl, { max: 1, onnotice: () => undefined })
  : undefined;
const organizationId = "00000000-0000-4000-8000-000000000001";
const mint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

describeDatabase("durable operational health producers", () => {
  let database: OrganizationDatabase;
  let health: OperationalHealthStore;

  beforeAll(async () => {
    await admin!.unsafe(`CREATE SCHEMA ${schema}`);
  });

  beforeEach(async () => {
    await database?.close();
    await admin!.unsafe(`DROP SCHEMA ${schema} CASCADE`);
    await admin!.unsafe(`CREATE SCHEMA ${schema}`);
    await runIngestionMigrations(databaseUrl!);
    await runReconciliationMigrations(databaseUrl!);
    await runWebhookMigrations(databaseUrl!);
    await runTestPlatformMigrations(databaseUrl!);
    database = new OrganizationDatabase(databaseUrl!, { max: 8 });
    health = new OperationalHealthStore(database);
  });

  afterAll(async () => {
    await database?.close();
    await admin!.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await cleanupTestProductionRoles(databaseUrl!);
    await admin?.end();
  });

  it("rolls consensus completion back on handoff failure and replays once", async () => {
    const ingestion = new PostgresIngestionStore({
      databaseUrl: databaseUrl!,
      selfHostedDefaultOrganization: true,
    });
    try {
      const now = new Date();
      await seedConsensusProviders(ingestion, now);
      const claim = await ingestion.claimFinalizedConsensus({
        primaryProviderId: "health-primary",
        secondaryProviderId: "health-secondary",
        signature: "1".repeat(64),
        now,
      });
      if (claim.kind !== "claimed")
        throw new Error("consensus was not claimed");
      const completion = {
        claim,
        state: "disagreed" as const,
        observations: disagreementObservations(now),
      };

      await installFailingSignalTrigger();
      await expect(
        ingestion.completeFinalizedConsensus(completion),
      ).rejects.toMatchObject({ code: "database_unavailable" });
      await expect(sourceState("rpc_consensus_checks")).resolves.toEqual({
        sourceCount: 1,
        terminalCount: 0,
        signalCount: 0,
      });

      await removeFailingSignalTrigger();
      await expect(
        ingestion.completeFinalizedConsensus(completion),
      ).resolves.toMatchObject({ applied: true, state: "disagreed" });
      await expect(drainAndInspect("rpc_disagreement")).resolves.toEqual({
        firstDrain: 2,
        secondDrain: 0,
        occurrenceCount: 1,
      });
    } finally {
      await ingestion.close();
    }
  });

  it("rolls webhook terminal state back on handoff failure and replays once", async () => {
    const webhooks = new PostgresWebhookStore({
      databaseUrl: databaseUrl!,
      selfHostedDefaultOrganization: true,
    });
    try {
      const now = new Date();
      await webhooks.addEndpoint(
        {
          id: "health-endpoint",
          url: "https://hooks.example.invalid/payops",
          secretEnv: "HEALTH_WEBHOOK_SECRET",
        },
        now,
      );
      await seedWebhookDelivery(now);
      const [claim] = await webhooks.claimDueDeliveries({
        now,
        limit: 1,
        leaseMs: 30_000,
      });
      if (claim === undefined) throw new Error("delivery was not claimed");
      const completion = {
        deliveryId: claim.deliveryId,
        leaseToken: claim.leaseToken,
        state: "dead" as const,
        completedAt: new Date(now.getTime() + 100),
        nextAttemptAt: null,
        httpStatus: 500,
        errorCode: "http_500",
        durationMs: 100,
      };

      await installFailingSignalTrigger();
      await expect(webhooks.completeDelivery(completion)).rejects.toThrow();
      await expect(sourceState("webhook_delivery_attempts")).resolves.toEqual({
        sourceCount: 1,
        terminalCount: 0,
        signalCount: 0,
      });

      await removeFailingSignalTrigger();
      await expect(webhooks.completeDelivery(completion)).resolves.toBe(true);
      await expect(webhooks.completeDelivery(completion)).resolves.toBe(false);
      await expect(drainAndInspect("webhook_dead_letter")).resolves.toEqual({
        firstDrain: 2,
        secondDrain: 0,
        occurrenceCount: 1,
      });
    } finally {
      await webhooks.close();
    }
  });

  it("rolls ledger mismatch back on handoff failure and replays once", async () => {
    const walletId = randomUUID();
    await seedWallet(walletId);
    const ledger = new LedgerStore(database);
    const input = {
      organizationId,
      actorId: "ledger-worker",
      walletId,
      mint,
      comparisonSlot: "100",
      observedBaseUnits: "1",
      coverageComplete: true,
      reasonCode: "scheduled_check",
      now: new Date(),
    };

    await installFailingSignalTrigger();
    await expect(ledger.reconcileWallet(input)).rejects.toMatchObject({
      code: "ledger_store_unavailable",
    });
    await expect(sourceState("ledger_reconciliations")).resolves.toEqual({
      sourceCount: 0,
      terminalCount: 0,
      signalCount: 0,
    });

    await removeFailingSignalTrigger();
    await expect(ledger.reconcileWallet(input)).resolves.toMatchObject({
      balanceState: "mismatch",
      differenceBaseUnits: "1",
    });
    await expect(drainAndInspect("ledger_mismatch")).resolves.toEqual({
      firstDrain: 1,
      secondDrain: 0,
      occurrenceCount: 1,
    });
  });

  async function installFailingSignalTrigger(): Promise<void> {
    await admin!.unsafe(`
      CREATE FUNCTION ${schema}.task4_fail_health_signal()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'forced durable handoff failure';
      END $$;
      CREATE TRIGGER task4_fail_health_signal
      BEFORE INSERT ON ${schema}.operational_health_signals
      FOR EACH ROW EXECUTE FUNCTION ${schema}.task4_fail_health_signal()
    `);
  }

  async function removeFailingSignalTrigger(): Promise<void> {
    await admin!.unsafe(`
      DROP TRIGGER task4_fail_health_signal
        ON ${schema}.operational_health_signals;
      DROP FUNCTION ${schema}.task4_fail_health_signal()
    `);
  }

  async function sourceState(
    source:
      | "rpc_consensus_checks"
      | "webhook_delivery_attempts"
      | "ledger_reconciliations",
  ): Promise<{
    readonly sourceCount: number;
    readonly terminalCount: number;
    readonly signalCount: number;
  }> {
    return database.transaction(
      { organizationId, actorId: "test" },
      async (sql) => {
        const terminal =
          source === "rpc_consensus_checks"
            ? "state <> 'pending'"
            : source === "webhook_delivery_attempts"
              ? "completed_at IS NOT NULL"
              : "balance_state = 'mismatch'";
        const [row] = await sql.unsafe<
          {
            source_count: number;
            terminal_count: number;
            signal_count: number;
          }[]
        >(`
          SELECT
            (SELECT count(*)::integer FROM ${source}) AS source_count,
            (SELECT count(*)::integer FROM ${source} WHERE ${terminal})
              AS terminal_count,
            (SELECT count(*)::integer FROM operational_health_signals)
              AS signal_count
        `);
        return {
          sourceCount: row!.source_count,
          terminalCount: row!.terminal_count,
          signalCount: row!.signal_count,
        };
      },
    );
  }

  async function drainAndInspect(kind: string): Promise<{
    readonly firstDrain: number;
    readonly secondDrain: number;
    readonly occurrenceCount: number;
  }> {
    const processedAt = new Date(Date.now() + 1_000);
    const firstDrain = await health.drainSignals({
      organizationId,
      actorId: "worker",
      processedAt,
    });
    const secondDrain = await health.drainSignals({
      organizationId,
      actorId: "worker",
      processedAt: new Date(processedAt.getTime() + 1),
    });
    const incidents = await health.listIncidents({
      organizationId,
      actorId: "operator",
      limit: 10,
    });
    const incident = incidents.items.find(
      (candidate) => candidate.kind === kind,
    );
    if (incident === undefined)
      throw new Error("expected incident was not materialized");
    return {
      firstDrain,
      secondDrain,
      occurrenceCount: incident.occurrenceCount,
    };
  }

  async function seedWebhookDelivery(now: Date): Promise<void> {
    await database.transaction(
      { organizationId, actorId: "test" },
      async (sql) => {
        const eventId = randomUUID();
        await sql`
          INSERT INTO webhook_events (
            id, organization_id, event_type, source_type, source_id,
            source_version, payload, payload_digest, occurred_at, created_at
          ) VALUES (
            ${eventId}::uuid, ${organizationId}::uuid, 'invoice.issued',
            'invoice', 'health-invoice', 1, '{}', ${"d".repeat(64)},
            ${now.toISOString()}, ${now.toISOString()}
          )
        `;
        await sql`
          INSERT INTO webhook_deliveries (
            endpoint_id, event_id, state, next_attempt_at, created_at, updated_at
          ) VALUES (
            'health-endpoint', ${eventId}::uuid, 'pending',
            ${now.toISOString()}, ${now.toISOString()}, ${now.toISOString()}
          )
        `;
      },
    );
  }

  async function seedWallet(walletId: string): Promise<void> {
    await database.transaction(
      { organizationId, actorId: "test" },
      async (sql) => {
        await sql`
          INSERT INTO merchant_wallets (
            id, organization_id, address, cluster, status, verified_at,
            created_at, updated_at
          ) VALUES (
            ${walletId}::uuid, ${organizationId}::uuid,
            ${walletId.replaceAll("-", "")}, 'mainnet-beta', 'active',
            clock_timestamp(), clock_timestamp(), clock_timestamp()
          )
        `;
      },
    );
  }
});

async function seedConsensusProviders(
  ingestion: PostgresIngestionStore,
  now: Date,
): Promise<void> {
  for (const id of ["health-primary", "health-secondary"]) {
    await ingestion.addProvider({
      id,
      cluster: "mainnet-beta",
      endpointEnv: `${id.replace("-", "_").toUpperCase()}_RPC`,
      endpointLabel: id,
    });
  }
  await ingestion.setProviderRole({
    cluster: "mainnet-beta",
    role: "primary",
    providerId: "health-primary",
    now,
  });
  await ingestion.setProviderRole({
    cluster: "mainnet-beta",
    role: "secondary",
    providerId: "health-secondary",
    now,
  });
}

function disagreementObservations(now: Date): FinalizedProviderObservation[] {
  return ["health-primary", "health-secondary"].map((providerId, index) => ({
    providerId,
    canonicalDigest: "a".repeat(64),
    snapshotDigest: "b".repeat(64),
    parsingDigest: (index === 0 ? "c" : "d").repeat(64),
    transferIdentityDigest: "e".repeat(64),
    statusSlot: 1n,
    slot: 1n,
    executionState: "succeeded" as const,
    executionDigest: "f".repeat(64),
    statusExecutionDigest: "1".repeat(64),
    transactionExecutionDigest: "1".repeat(64),
    finality: "finalized/finalized",
    responseTimeMs: 5,
    safeErrorCode: null,
    safeErrorRetryable: null,
    observedAt: now,
  }));
}

function withSearchPath(urlString: string, schemaName: string): string {
  const url = new URL(urlString);
  url.searchParams.set("options", `-csearch_path=${schemaName}`);
  return url.toString();
}
