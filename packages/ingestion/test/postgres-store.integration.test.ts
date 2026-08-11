import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  parseTransactionTransfers,
  PaymentFixtureSchema,
  type RpcTransactionEnvelope,
} from "@payops/core";
import postgres from "postgres";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  createCanonicalSnapshot,
  PostgresIngestionStore,
  runMigrations,
} from "../src/index.js";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://payops:payops@127.0.0.1:55432/payops_test";
const fixturePath = fileURLToPath(
  new URL(
    "../../../fixtures/v0.1/usdc-transfer-checked-finalized.json",
    import.meta.url,
  ),
);
const now = new Date("2026-08-06T00:00:00Z");
let transaction: RpcTransactionEnvelope;
let store: PostgresIngestionStore;
const cleanup = postgres(databaseUrl, { max: 1 });

async function seedProviderAndWatch(): Promise<void> {
  await store.addProvider({
    id: "primary",
    cluster: "mainnet-beta",
    endpointEnv: "SOLANA_RPC_URL",
    endpointLabel: "rpc.example",
  });
  await store.addWatchTarget({
    id: "watch-1",
    providerId: "primary",
    cluster: "mainnet-beta",
    address: "Cmn8RVNLZAtyq51B31RXDrrS24DYphEftzDCX4FzPLM",
    cutoverSlot: 1n,
    cutoverSignature: null,
    overlapSlots: 150n,
    createdAt: now,
  });
}

beforeAll(async () => {
  await runMigrations(databaseUrl);
  await runMigrations(databaseUrl);
  store = new PostgresIngestionStore({ databaseUrl });
  transaction = PaymentFixtureSchema.parse(
    JSON.parse(await readFile(fixturePath, "utf8")),
  ).rpcTransaction;
});

beforeEach(async () => {
  await cleanup.unsafe(`
    TRUNCATE TABLE
      finality_observations,
      event_references,
      normalized_transfers,
      chain_events,
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
  await cleanup.end();
});

describe("PostgresIngestionStore", () => {
  it("keeps idempotent migration notices out of command output", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runMigrations(databaseUrl);

    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("round-trips provider and watch configuration", async () => {
    await seedProviderAndWatch();

    expect(await store.getProvider("primary")).toMatchObject({
      cluster: "mainnet-beta",
      endpointEnv: "SOLANA_RPC_URL",
    });
    expect(await store.getWatchTarget("watch-1")).toMatchObject({
      address: "Cmn8RVNLZAtyq51B31RXDrrS24DYphEftzDCX4FzPLM",
      cutoverSlot: 1n,
      overlapSlots: 150n,
    });
  });

  it("rejects a reused watch ID with different immutable configuration", async () => {
    await seedProviderAndWatch();

    await expect(
      store.addWatchTarget({
        id: "watch-1",
        providerId: "primary",
        cluster: "mainnet-beta",
        address: "8rUz82MkFsfqjpVjjgWEM66Brr1sm1R7VKZ991fF41e",
        cutoverSlot: 2n,
        cutoverSignature: null,
        overlapSlots: 150n,
        createdAt: now,
      }),
    ).rejects.toThrow(
      "Watch target ID already has different immutable configuration",
    );
  });

  it("rejects a second active watch identity with a different ID", async () => {
    await seedProviderAndWatch();

    await expect(
      store.addWatchTarget({
        id: "watch-2",
        providerId: "primary",
        cluster: "mainnet-beta",
        address: "Cmn8RVNLZAtyq51B31RXDrrS24DYphEftzDCX4FzPLM",
        cutoverSlot: 1n,
        cutoverSignature: null,
        overlapSlots: 150n,
        createdAt: now,
      }),
    ).rejects.toMatchObject({
      code: "invalid_configuration",
      retryable: false,
    });
  });

  it("serializes concurrent migration runners", async () => {
    await cleanup`
      DELETE FROM payops_schema_migrations
      WHERE name IN (
        '0001_durable_ingestion',
        '0002_finality_claim_token',
        '0003_pending_representation'
      )
    `;

    await expect(
      Promise.all([runMigrations(databaseUrl), runMigrations(databaseUrl)]),
    ).resolves.toEqual([undefined, undefined]);
    const rows = await cleanup<{ name: string }[]>`
      SELECT name
      FROM payops_schema_migrations
      WHERE name IN (
        '0001_durable_ingestion',
        '0002_finality_claim_token',
        '0003_pending_representation'
      )
      ORDER BY name
    `;
    expect(rows.map(({ name }) => name)).toEqual([
      "0001_durable_ingestion",
      "0002_finality_claim_token",
      "0003_pending_representation",
    ]);
  });

  it("holds an advisory lock on a dedicated connection", async () => {
    await seedProviderAndWatch();

    const first = await store.tryAcquireSyncLock("primary", "watch-1");
    const second = await store.tryAcquireSyncLock("primary", "watch-1");

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    await first?.release();
    const third = await store.tryAcquireSyncLock("primary", "watch-1");
    expect(third).not.toBeNull();
    await third?.release();
  });

  it("stores one raw snapshot and event across replay", async () => {
    await seedProviderAndWatch();
    const discovered = {
      signature: transaction.signature,
      slot: BigInt(transaction.slot),
      blockTime: BigInt(transaction.blockTime ?? 0),
      err: null,
      confirmationStatus: "confirmed" as const,
    };
    const runId = await store.startSyncRun({
      providerId: "primary",
      watchTargetId: "watch-1",
      startedAt: now,
      startingHeadSignature: null,
      startingHeadSlot: null,
      capturedHead: discovered,
    });
    const input = {
      runId,
      providerId: "primary",
      watchTargetId: "watch-1",
      discovered,
      classification: "parsed" as const,
      snapshot: createCanonicalSnapshot(transaction),
      transaction,
      transfers: parseTransactionTransfers(transaction),
      parserVersion: "0.2.0",
      observedAt: now,
    };

    const first = await store.recordRepresentation(input);
    const second = await store.recordRepresentation(input);

    expect(first).toMatchObject({ signatureInserted: true, eventsInserted: 1 });
    expect(second).toMatchObject({
      signatureInserted: false,
      eventsInserted: 0,
    });
    const rows = await cleanup`
      SELECT
        (SELECT count(*)::int FROM raw_transactions) AS raw_count,
        (SELECT count(*)::int FROM chain_events) AS event_count,
        (SELECT count(*)::int FROM event_references) AS reference_count
    `;
    expect(rows[0]).toMatchObject({
      raw_count: 1,
      event_count: 1,
      reference_count: 1,
    });
  });

  it("rejects noncanonical parser versions before representation writes", async () => {
    await seedProviderAndWatch();
    const discovered = {
      signature: transaction.signature,
      slot: BigInt(transaction.slot),
      blockTime: BigInt(transaction.blockTime ?? 0),
      err: null,
      confirmationStatus: "confirmed" as const,
    };
    const runId = await store.startSyncRun({
      providerId: "primary",
      watchTargetId: "watch-1",
      startedAt: now,
      startingHeadSignature: null,
      startingHeadSlot: null,
      capturedHead: discovered,
    });
    const baseInput = {
      runId,
      providerId: "primary",
      watchTargetId: "watch-1",
      discovered,
      classification: "parsed" as const,
      snapshot: createCanonicalSnapshot(transaction),
      transaction,
      transfers: parseTransactionTransfers(transaction),
      observedAt: now,
    };

    for (const parserVersion of [
      "0.2",
      "0.2.0-beta.1",
      "0.2.0+build.1",
      "00.2.0",
      "0.02.0",
      "0.2.00",
      "v0.2.0",
      " 0.2.0",
      "1000000000.0.0",
      "0.1000000000.0",
      "0.0.1000000000",
      `1${"0".repeat(1_000)}.0.0`,
    ]) {
      await expect(
        store.recordRepresentation({ ...baseInput, parserVersion }),
      ).rejects.toMatchObject({
        code: "invalid_configuration",
        retryable: false,
      });
    }
    const [empty] = await cleanup<
      { discovered: number; raw: number; events: number; transfers: number }[]
    >`
      SELECT
        (SELECT count(*)::integer FROM discovered_signatures) AS discovered,
        (SELECT count(*)::integer FROM raw_transactions) AS raw,
        (SELECT count(*)::integer FROM chain_events) AS events,
        (SELECT count(*)::integer FROM normalized_transfers) AS transfers
    `;
    expect(empty).toEqual({ discovered: 0, raw: 0, events: 0, transfers: 0 });

    await expect(
      store.recordRepresentation({
        ...baseInput,
        parserVersion: "999999999.999999999.999999999",
      }),
    ).resolves.toMatchObject({ signatureInserted: true, eventsInserted: 1 });
    await expect(
      cleanup<{ parser_version: string }[]>`
        SELECT parser_version FROM normalized_transfers
      `,
    ).resolves.toEqual([{ parser_version: "999999999.999999999.999999999" }]);
  });

  it("promotes pending discovery and resolves recovered transaction work atomically", async () => {
    await seedProviderAndWatch();
    const discovered = {
      signature: transaction.signature,
      slot: BigInt(transaction.slot),
      blockTime: BigInt(transaction.blockTime ?? 0),
      err: null,
      confirmationStatus: "confirmed" as const,
    };
    const runId = await store.startSyncRun({
      providerId: "primary",
      watchTargetId: "watch-1",
      startedAt: now,
      startingHeadSignature: null,
      startingHeadSlot: null,
      capturedHead: discovered,
    });

    await store.recordRepresentation({
      runId,
      providerId: "primary",
      watchTargetId: "watch-1",
      discovered,
      classification: "pending",
      snapshot: null,
      transaction: null,
      transfers: [],
      parserVersion: "0.2.0",
      observedAt: now,
    });
    for (const operation of ["transaction", "storage"] as const) {
      await store.recordRetry({
        runId,
        providerId: "primary",
        watchTargetId: "watch-1",
        signature: transaction.signature,
        operation,
        code:
          operation === "transaction"
            ? "rpc_transaction_missing"
            : "database_unavailable",
        message: `safe ${operation} failure`,
        now,
      });
    }

    const pending = await cleanup<
      { representation_class: string; finality_state: string; open: number }[]
    >`
      SELECT representation_class, finality_state,
        (SELECT count(*)::int FROM ingestion_retries WHERE resolved_at IS NULL) AS open
      FROM discovered_signatures
      WHERE signature = ${transaction.signature}
    `;
    expect(pending[0]).toEqual({
      representation_class: "pending",
      finality_state: "detected",
      open: 2,
    });
    expect(await store.claimFinalityCandidates("primary", 10, now)).toEqual([]);

    await store.recordRepresentation({
      runId,
      providerId: "primary",
      watchTargetId: "watch-1",
      discovered,
      classification: "parsed",
      snapshot: createCanonicalSnapshot(transaction),
      transaction,
      transfers: parseTransactionTransfers(transaction),
      parserVersion: "0.2.0",
      observedAt: new Date(now.getTime() + 1_000),
    });

    const recovered = await cleanup<
      { representation_class: string; finality_state: string; open: number }[]
    >`
      SELECT representation_class, finality_state,
        (SELECT count(*)::int FROM ingestion_retries WHERE resolved_at IS NULL) AS open
      FROM discovered_signatures
      WHERE signature = ${transaction.signature}
    `;
    expect(recovered[0]).toEqual({
      representation_class: "parsed",
      finality_state: "confirmed",
      open: 0,
    });
    expect(
      await store.claimFinalityCandidates("primary", 10, now),
    ).toHaveLength(1);
  });

  it("resolves page retry work after a complete page scan", async () => {
    await seedProviderAndWatch();
    const runId = await store.startSyncRun({
      providerId: "primary",
      watchTargetId: "watch-1",
      startedAt: now,
      startingHeadSignature: null,
      startingHeadSlot: null,
      capturedHead: null,
    });
    await store.recordRetry({
      runId,
      providerId: "primary",
      watchTargetId: "watch-1",
      signature: null,
      operation: "page",
      code: "rpc_transport_error",
      message: "safe page failure",
      now,
    });

    expect(
      await store.resolveRetry({
        providerId: "primary",
        watchTargetId: "watch-1",
        signature: null,
        operation: "page",
        resolvedAt: new Date(now.getTime() + 1_000),
      }),
    ).toBe(true);
    const rows = await cleanup<{ open: number }[]>`
      SELECT count(*)::int AS open
      FROM ingestion_retries
      WHERE resolved_at IS NULL
    `;
    expect(rows[0]?.open).toBe(0);
  });

  it("inspects complete signature evidence while withholding raw bodies by default", async () => {
    await seedProviderAndWatch();
    const discovered = {
      signature: transaction.signature,
      slot: BigInt(transaction.slot),
      blockTime: BigInt(transaction.blockTime ?? 0),
      err: null,
      confirmationStatus: "confirmed" as const,
    };
    const runId = await store.startSyncRun({
      providerId: "primary",
      watchTargetId: "watch-1",
      startedAt: now,
      startingHeadSignature: null,
      startingHeadSlot: null,
      capturedHead: discovered,
    });
    await store.recordRepresentation({
      runId,
      providerId: "primary",
      watchTargetId: "watch-1",
      discovered,
      classification: "parsed",
      snapshot: createCanonicalSnapshot(transaction),
      transaction,
      transfers: parseTransactionTransfers(transaction),
      parserVersion: "0.2.0",
      observedAt: now,
    });
    await store.recordRetry({
      runId,
      providerId: "primary",
      watchTargetId: "watch-1",
      signature: transaction.signature,
      operation: "finality",
      code: "rpc_transport_error",
      message: "safe finality failure",
      now,
    });
    await cleanup`
      INSERT INTO ingestion_quarantines (
        run_id, provider_id, watch_target_id, signature, code, safe_message,
        created_at
      ) VALUES (
        ${runId}, 'primary', 'watch-1', ${transaction.signature},
        'rpc_transaction_schema_invalid', 'safe quarantine',
        ${now.toISOString()}
      )
    `;
    await cleanup`
      INSERT INTO finality_observations (
        provider_id, signature, observed_status, observed_state, context_slot,
        response_digest, code, observed_at
      ) VALUES (
        'primary', ${transaction.signature},
        ${JSON.stringify({ confirmationStatus: "confirmed" })}::jsonb,
        'confirmed', ${transaction.slot}, 'inspection-digest', NULL,
        ${now.toISOString()}
      )
    `;

    const redacted = (await store.inspectSignature(transaction.signature, {
      includeRaw: false,
    })) as Record<string, unknown>;
    const redactedRaw = (
      redacted.rawTransactions as Record<string, unknown>[]
    )[0];
    expect(redacted).toMatchObject({
      discovery: {
        signature: transaction.signature,
        representationClass: "parsed",
      },
    });
    expect(redactedRaw).not.toHaveProperty("body");
    expect(redactedRaw).not.toHaveProperty("canonicalBody");
    expect(redacted.events).toMatchObject([
      {
        eventId: expect.any(String),
        references: ["Gh5GixNvrU87vKWcLLLp6dcgBGRDtP4EJesFu6rjif4"],
        transfers: [{ amountBaseUnits: "12500000", decimals: 6 }],
      },
    ]);
    expect(redacted.retries).toHaveLength(1);
    expect(redacted.quarantines).toHaveLength(1);
    expect(redacted.finalityObservations).toHaveLength(1);

    const included = (await store.inspectSignature(transaction.signature, {
      includeRaw: true,
    })) as Record<string, unknown>;
    const includedRaw = (
      included.rawTransactions as Record<string, unknown>[]
    )[0];
    expect(includedRaw).toHaveProperty("body");
    expect(includedRaw).toHaveProperty("canonicalBody");
  });

  it("advances the cursor only when the starting boundary still matches", async () => {
    await seedProviderAndWatch();
    const head = {
      signature: transaction.signature,
      slot: BigInt(transaction.slot),
      blockTime: BigInt(transaction.blockTime ?? 0),
      err: null,
      confirmationStatus: "confirmed" as const,
    };
    const runId = await store.startSyncRun({
      providerId: "primary",
      watchTargetId: "watch-1",
      startedAt: now,
      startingHeadSignature: null,
      startingHeadSlot: null,
      capturedHead: head,
    });
    const completion = {
      runId,
      watchTargetId: "watch-1",
      capturedHead: head,
      completedAt: now,
      result: "complete" as const,
      coverage: "complete" as const,
      advanceCursor: true,
      counts: {
        pagesRead: 0,
        signaturesDiscovered: 1,
        signaturesStored: 1,
        eventsStored: 1,
        retriesCreated: 0,
        quarantinesCreated: 0,
      },
    };

    expect(
      await store.completeSyncRun({
        ...completion,
        startingHeadSignature: "stale",
      }),
    ).toBe(false);
    expect(
      await store.completeSyncRun({
        ...completion,
        startingHeadSignature: null,
      }),
    ).toBe(true);
    expect(
      (await store.getWatchTarget("watch-1"))?.committedHeadSignature,
    ).toBe(transaction.signature);
  });

  it("claims provisional signatures once during a worker lease", async () => {
    await seedProviderAndWatch();
    const discovered = {
      signature: transaction.signature,
      slot: BigInt(transaction.slot),
      blockTime: BigInt(transaction.blockTime ?? 0),
      err: null,
      confirmationStatus: "confirmed" as const,
    };
    const runId = await store.startSyncRun({
      providerId: "primary",
      watchTargetId: "watch-1",
      startedAt: now,
      startingHeadSignature: null,
      startingHeadSlot: null,
      capturedHead: discovered,
    });
    await store.recordRepresentation({
      runId,
      providerId: "primary",
      watchTargetId: "watch-1",
      discovered,
      classification: "parsed",
      snapshot: createCanonicalSnapshot(transaction),
      transaction,
      transfers: parseTransactionTransfers(transaction),
      parserVersion: "0.2.0",
      observedAt: now,
    });

    const first = await store.claimFinalityCandidates("primary", 10, now);
    const second = await store.claimFinalityCandidates("primary", 10, now);

    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      signature: transaction.signature,
      state: "confirmed",
    });
    expect(second).toHaveLength(0);
  });

  it("prevents an expired finality worker from regressing terminal state", async () => {
    await seedProviderAndWatch();
    const discovered = {
      signature: transaction.signature,
      slot: BigInt(transaction.slot),
      blockTime: BigInt(transaction.blockTime ?? 0),
      err: null,
      confirmationStatus: "confirmed" as const,
    };
    const runId = await store.startSyncRun({
      providerId: "primary",
      watchTargetId: "watch-1",
      startedAt: now,
      startingHeadSignature: null,
      startingHeadSlot: null,
      capturedHead: discovered,
    });
    await store.recordRepresentation({
      runId,
      providerId: "primary",
      watchTargetId: "watch-1",
      discovered,
      classification: "parsed",
      snapshot: createCanonicalSnapshot(transaction),
      transaction,
      transfers: parseTransactionTransfers(transaction),
      parserVersion: "0.2.0",
      observedAt: now,
    });
    const stale = (await store.claimFinalityCandidates("primary", 1, now))[0];
    const current = (
      await store.claimFinalityCandidates(
        "primary",
        1,
        new Date(now.getTime() + 61_000),
      )
    )[0];
    if (stale === undefined || current === undefined) {
      throw new Error("Expected two successive lease claims");
    }
    await store.recordRetry({
      runId: null,
      providerId: "primary",
      watchTargetId: "watch-1",
      signature: transaction.signature,
      operation: "finality",
      code: "rpc_transport_error",
      message: "Finality operation failed with rpc_transport_error",
      now,
    });

    await store.recordFinalityObservation({
      candidate: current,
      observedStatus: {
        signature: transaction.signature,
        slot: BigInt(transaction.slot),
        confirmationStatus: "finalized",
        err: null,
      },
      observedAt: new Date(now.getTime() + 61_000),
      contextSlot: BigInt(transaction.slot) + 100n,
      responseDigest: "current-finalized",
      finalizedSnapshot: createCanonicalSnapshot(transaction),
      nextState: "finalized",
    });
    await store.recordFinalityObservation({
      candidate: stale,
      observedStatus: null,
      observedAt: new Date(now.getTime() + 62_000),
      contextSlot: BigInt(transaction.slot) + 101n,
      responseDigest: "stale-reverted",
      finalizedSnapshot: null,
      nextState: "reverted",
      code: "finality_status_missing",
    });
    const staleRetryInserted = await store.recordRetry({
      runId: null,
      providerId: stale.providerId,
      watchTargetId: stale.watchTargetId,
      signature: stale.signature,
      operation: "finality",
      code: "rpc_transport_error",
      message: "Finality operation failed with rpc_transport_error",
      now: new Date(now.getTime() + 63_000),
      finalityClaimToken: stale.claimToken,
      finalityClaimState: stale.state,
    });

    const rows = await cleanup<
      {
        finality_state: string;
        event_state: string;
        observation_count: number;
        open_retry_count: number;
      }[]
    >`
      SELECT d.finality_state, e.current_state AS event_state,
        (SELECT count(*)::int FROM finality_observations) AS observation_count,
        (SELECT count(*)::int FROM ingestion_retries WHERE resolved_at IS NULL) AS open_retry_count
      FROM discovered_signatures d
      JOIN chain_events e ON e.signature = d.signature
      WHERE d.signature = ${transaction.signature}
    `;
    expect(rows[0]).toEqual({
      finality_state: "finalized",
      event_state: "finalized",
      observation_count: 1,
      open_retry_count: 0,
    });
    expect(staleRetryInserted).toBe(false);
  });

  it("quarantines a replay whose normalized event identity changed", async () => {
    await seedProviderAndWatch();
    const discovered = {
      signature: transaction.signature,
      slot: BigInt(transaction.slot),
      blockTime: BigInt(transaction.blockTime ?? 0),
      err: null,
      confirmationStatus: "confirmed" as const,
    };
    const runId = await store.startSyncRun({
      providerId: "primary",
      watchTargetId: "watch-1",
      startedAt: now,
      startingHeadSignature: null,
      startingHeadSlot: null,
      capturedHead: discovered,
    });
    const transfers = parseTransactionTransfers(transaction);
    const baseInput = {
      runId,
      providerId: "primary",
      watchTargetId: "watch-1",
      discovered,
      classification: "parsed" as const,
      snapshot: createCanonicalSnapshot(transaction),
      transaction,
      parserVersion: "0.2.0",
      observedAt: now,
    };
    await store.recordRepresentation({ ...baseInput, transfers });
    const changed = transfers.map((transfer) => ({
      ...transfer,
      amountBaseUnits: "999",
    }));

    const replay = await store.recordRepresentation({
      ...baseInput,
      transfers: changed,
    });
    const duplicateReplay = await store.recordRepresentation({
      ...baseInput,
      transfers: changed,
    });

    expect(replay).toMatchObject({
      eventsInserted: 0,
      quarantineInserted: true,
    });
    expect(duplicateReplay.quarantineInserted).toBe(false);
    const rows = await cleanup<
      { amount_base_units: string; quarantine_count: number }[]
    >`
      SELECT amount_base_units,
        (SELECT count(*)::int FROM ingestion_quarantines) AS quarantine_count
      FROM normalized_transfers
    `;
    expect(rows[0]).toEqual({
      amount_base_units: "12500000",
      quarantine_count: 1,
    });
  });

  it("serializes conflicting raw representations for one provider signature", async () => {
    await seedProviderAndWatch();
    const discovered = {
      signature: transaction.signature,
      slot: BigInt(transaction.slot),
      blockTime: BigInt(transaction.blockTime ?? 0),
      err: null,
      confirmationStatus: "confirmed" as const,
    };
    const runId = await store.startSyncRun({
      providerId: "primary",
      watchTargetId: "watch-1",
      startedAt: now,
      startingHeadSignature: null,
      startingHeadSlot: null,
      capturedHead: discovered,
    });
    const changedMetadata = structuredClone(transaction);
    Object.assign(changedMetadata.meta, { providerExtension: "changed" });
    const input = {
      runId,
      providerId: "primary",
      watchTargetId: "watch-1",
      discovered,
      classification: "parsed" as const,
      transfers: parseTransactionTransfers(transaction),
      parserVersion: "0.2.0",
      observedAt: now,
    };

    const results = await Promise.all([
      store.recordRepresentation({
        ...input,
        snapshot: createCanonicalSnapshot(transaction),
        transaction,
      }),
      store.recordRepresentation({
        ...input,
        snapshot: createCanonicalSnapshot(changedMetadata),
        transaction: changedMetadata,
      }),
    ]);

    expect(results.filter((result) => result.quarantineInserted)).toHaveLength(
      1,
    );
    const rows = await cleanup<
      { raw_count: number; quarantine_count: number }[]
    >`
      SELECT
        (SELECT count(*)::int FROM raw_transactions) AS raw_count,
        (SELECT count(*)::int FROM ingestion_quarantines) AS quarantine_count
    `;
    expect(rows[0]).toEqual({ raw_count: 2, quarantine_count: 1 });
  });

  it("does not allow replay to move a quarantined signature to confirmed", async () => {
    await seedProviderAndWatch();
    const discovered = {
      signature: transaction.signature,
      slot: BigInt(transaction.slot),
      blockTime: BigInt(transaction.blockTime ?? 0),
      err: null,
      confirmationStatus: "confirmed" as const,
    };
    const runId = await store.startSyncRun({
      providerId: "primary",
      watchTargetId: "watch-1",
      startedAt: now,
      startingHeadSignature: null,
      startingHeadSlot: null,
      capturedHead: discovered,
    });
    const baseInput = {
      runId,
      providerId: "primary",
      watchTargetId: "watch-1",
      discovered,
      snapshot: createCanonicalSnapshot(transaction),
      transaction,
      transfers: parseTransactionTransfers(transaction),
      parserVersion: "0.2.0",
      observedAt: now,
    };
    await store.recordRepresentation({
      ...baseInput,
      classification: "quarantined",
      quarantineCode: "rpc_transaction_schema_invalid",
    });
    await store.recordRepresentation({
      ...baseInput,
      classification: "parsed",
    });

    const rows = await cleanup<{ finality_state: string }[]>`
      SELECT finality_state FROM discovered_signatures
      WHERE watch_target_id = 'watch-1'
        AND signature = ${transaction.signature}
    `;
    expect(rows[0]?.finality_state).toBe("quarantined");
  });

  it("rechecks finalized raw evidence before recording a reversion", async () => {
    await seedProviderAndWatch();
    const confirmedTransaction = structuredClone(transaction);
    confirmedTransaction.commitment = "confirmed";
    const discovered = {
      signature: transaction.signature,
      slot: BigInt(transaction.slot),
      blockTime: BigInt(transaction.blockTime ?? 0),
      err: null,
      confirmationStatus: "confirmed" as const,
    };
    const runId = await store.startSyncRun({
      providerId: "primary",
      watchTargetId: "watch-1",
      startedAt: now,
      startingHeadSignature: null,
      startingHeadSlot: null,
      capturedHead: discovered,
    });
    await store.recordRepresentation({
      runId,
      providerId: "primary",
      watchTargetId: "watch-1",
      discovered,
      classification: "parsed",
      snapshot: createCanonicalSnapshot(confirmedTransaction),
      transaction: confirmedTransaction,
      transfers: parseTransactionTransfers(confirmedTransaction),
      parserVersion: "0.2.0",
      observedAt: now,
    });
    const claimed = (await store.claimFinalityCandidates("primary", 1, now))[0];
    if (claimed === undefined) throw new Error("Expected finality claim");
    const finalized = createCanonicalSnapshot(transaction);
    await cleanup`
      INSERT INTO raw_transactions (
        provider_id, signature, commitment, digest, canonical_body, body,
        byte_length, retrieved_at
      ) VALUES (
        'primary', ${transaction.signature}, 'finalized', ${finalized.digest},
        ${finalized.canonicalJson}, ${finalized.canonicalJson}::jsonb,
        ${finalized.byteLength}, ${now.toISOString()}
      )
    `;

    await store.recordFinalityObservation({
      candidate: claimed,
      observedStatus: null,
      observedAt: now,
      contextSlot: BigInt(transaction.slot) + 100n,
      responseDigest: "late-finalized-race",
      finalizedSnapshot: null,
      nextState: "reverted",
      code: "finality_status_missing",
    });

    const rows = await cleanup<{ finality_state: string }[]>`
      SELECT finality_state FROM discovered_signatures
      WHERE watch_target_id = 'watch-1'
        AND signature = ${transaction.signature}
    `;
    expect(rows[0]?.finality_state).toBe("confirmed");
  });

  it("quarantines conflicting finalized snapshots across watch targets", async () => {
    await seedProviderAndWatch();
    const confirmedTransaction = structuredClone(transaction);
    confirmedTransaction.commitment = "confirmed";
    await store.addWatchTarget({
      id: "watch-2",
      providerId: "primary",
      cluster: "mainnet-beta",
      address: "8rUz82MkFsfqjpVjjgWEM66Brr1sm1R7VKZ991fF41e",
      cutoverSlot: 1n,
      cutoverSignature: null,
      overlapSlots: 150n,
      createdAt: now,
    });
    const discovered = {
      signature: transaction.signature,
      slot: BigInt(transaction.slot),
      blockTime: BigInt(transaction.blockTime ?? 0),
      err: null,
      confirmationStatus: "confirmed" as const,
    };
    for (const watchTargetId of ["watch-1", "watch-2"]) {
      const runId = await store.startSyncRun({
        providerId: "primary",
        watchTargetId,
        startedAt: now,
        startingHeadSignature: null,
        startingHeadSlot: null,
        capturedHead: discovered,
      });
      await store.recordRepresentation({
        runId,
        providerId: "primary",
        watchTargetId,
        discovered,
        classification: "parsed",
        snapshot: createCanonicalSnapshot(confirmedTransaction),
        transaction: confirmedTransaction,
        transfers: parseTransactionTransfers(confirmedTransaction),
        parserVersion: "0.2.0",
        observedAt: now,
      });
    }
    const candidates = await store.claimFinalityCandidates("primary", 2, now);
    expect(candidates).toHaveLength(2);
    const changedMetadata = structuredClone(transaction);
    Object.assign(changedMetadata.meta, { providerExtension: "changed" });
    const snapshots = [
      createCanonicalSnapshot(transaction),
      createCanonicalSnapshot(changedMetadata),
    ];

    await Promise.all(
      candidates.map((entry, index) =>
        store.recordFinalityObservation({
          candidate: entry,
          observedStatus: {
            signature: transaction.signature,
            slot: BigInt(transaction.slot),
            confirmationStatus: "finalized",
            err: null,
          },
          observedAt: now,
          contextSlot: BigInt(transaction.slot) + 100n,
          responseDigest: `finalized-${index}`,
          finalizedSnapshot: snapshots[index] ?? null,
          nextState: "finalized",
        }),
      ),
    );

    const rows = await cleanup<
      {
        finalized_count: number;
        quarantined_count: number;
        raw_count: number;
        event_state: string;
      }[]
    >`
      SELECT
        count(*) FILTER (WHERE finality_state = 'finalized')::int AS finalized_count,
        count(*) FILTER (WHERE finality_state = 'quarantined')::int AS quarantined_count,
        (SELECT count(*)::int FROM raw_transactions WHERE commitment = 'finalized') AS raw_count,
        (SELECT current_state FROM chain_events LIMIT 1) AS event_state
      FROM discovered_signatures
    `;
    expect(rows[0]).toEqual({
      finalized_count: 1,
      quarantined_count: 1,
      raw_count: 2,
      event_state: "quarantined",
    });
  });

  it("serializes global event identity across different RPC providers", async () => {
    await seedProviderAndWatch();
    await store.addProvider({
      id: "secondary",
      cluster: "mainnet-beta",
      endpointEnv: "SECONDARY_RPC_URL",
      endpointLabel: "secondary.example",
    });
    await store.addWatchTarget({
      id: "watch-2",
      providerId: "secondary",
      cluster: "mainnet-beta",
      address: "8rUz82MkFsfqjpVjjgWEM66Brr1sm1R7VKZ991fF41e",
      cutoverSlot: 1n,
      cutoverSignature: null,
      overlapSlots: 150n,
      createdAt: now,
    });
    const discovered = {
      signature: transaction.signature,
      slot: BigInt(transaction.slot),
      blockTime: BigInt(transaction.blockTime ?? 0),
      err: null,
      confirmationStatus: "confirmed" as const,
    };
    const inputs = await Promise.all(
      [
        { providerId: "primary", watchTargetId: "watch-1", amount: "12500000" },
        { providerId: "secondary", watchTargetId: "watch-2", amount: "999" },
      ].map(async ({ providerId, watchTargetId, amount }) => ({
        runId: await store.startSyncRun({
          providerId,
          watchTargetId,
          startedAt: now,
          startingHeadSignature: null,
          startingHeadSlot: null,
          capturedHead: discovered,
        }),
        providerId,
        watchTargetId,
        discovered,
        classification: "parsed" as const,
        snapshot: createCanonicalSnapshot(transaction),
        transaction,
        transfers: parseTransactionTransfers(transaction).map((transfer) => ({
          ...transfer,
          amountBaseUnits: amount,
        })),
        parserVersion: "0.2.0",
        observedAt: now,
      })),
    );

    const results = await Promise.all(
      inputs.map((input) => store.recordRepresentation(input)),
    );

    expect(results.filter((result) => result.quarantineInserted)).toHaveLength(
      1,
    );
  });

  it("summarizes only selected watch coverage without raw evidence", async () => {
    await seedProviderAndWatch();
    await store.addWatchTarget({
      id: "watch-2",
      providerId: "primary",
      cluster: "mainnet-beta",
      address: "8rUz82MkFsfqjpVjjgWEM66Brr1sm1R7VKZ991fF41e",
      cutoverSlot: 1n,
      cutoverSignature: null,
      overlapSlots: 150n,
      createdAt: now,
    });
    await cleanup`
      UPDATE watch_targets SET
        coverage = 'incomplete',
        committed_head_slot = 499
      WHERE id = 'watch-1'
    `;
    await cleanup`
      INSERT INTO sync_runs (
        id, provider_id, watch_target_id, captured_head_signature,
        captured_head_slot, result, coverage, started_at, completed_at
      ) VALUES (
        '00000000-0000-4000-8000-000000000001', 'primary', 'watch-1',
        'captured-signature', 500, 'incomplete', 'incomplete', ${now}, ${now}
      )
    `;
    await cleanup`
      INSERT INTO discovered_signatures (
        watch_target_id, provider_id, signature, slot, confirmation_status,
        representation_class, finality_state, observed_at
      ) VALUES
        ('watch-1', 'primary', 'sig-finalized', 490, 'finalized', 'parsed', 'finalized', ${now}),
        ('watch-1', 'primary', 'sig-confirmed', 491, 'confirmed', 'parsed', 'confirmed', ${now}),
        ('watch-2', 'primary', 'sig-unrelated', 492, 'finalized', 'parsed', 'finalized', ${now})
    `;
    await cleanup`
      INSERT INTO ingestion_retries (
        provider_id, watch_target_id, signature, operation, code, safe_message,
        first_failed_at, last_failed_at, next_attempt_at
      ) VALUES
        ('primary', 'watch-1', 'sig-confirmed', 'finality', 'rpc_transport_error',
         'safe', ${now}, ${now}, ${now}),
        ('primary', 'watch-2', 'sig-unrelated', 'finality', 'rpc_transport_error',
         'safe', ${now}, ${now}, ${now})
    `;
    await cleanup`
      INSERT INTO ingestion_quarantines (
        provider_id, watch_target_id, signature, code, safe_message,
        review_state, created_at
      ) VALUES
        ('primary', 'watch-1', 'sig-quarantine', 'rpc_error', 'safe', 'open', ${now}),
        ('primary', 'watch-2', 'sig-unrelated', 'rpc_error', 'safe', 'open', ${now})
    `;

    const first = await store.getWatchCoverageSummaries(["watch-1"]);
    const second = await store.getWatchCoverageSummaries(["watch-1"]);

    expect(second).toEqual(first);
    expect(first).toEqual([
      {
        watchTargetId: "watch-1",
        coverage: "incomplete",
        capturedHeadSlot: "500",
        committedHeadSlot: "499",
        signatures: 2,
        finalized: 1,
        pendingFinality: 1,
        retriesOpen: 1,
        quarantinesOpen: 1,
      },
    ]);
    const serialized = JSON.stringify(first);
    expect(serialized).not.toContain("canonical_body");
    expect(serialized).not.toContain("body");
    expect(serialized).not.toContain("SOLANA_RPC_URL");
  });
});
