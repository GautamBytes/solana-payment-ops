import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  PaymentFixtureSchema,
  type RpcTransactionEnvelope,
} from "@payops/core";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createFinalityEngine,
  createParsingDigest,
  type FinalityCandidate,
  IngestionError,
} from "../src/index.js";
import { FakeRpc } from "./support/fake-rpc.js";
import { MemoryStore } from "./support/memory-store.js";

const fixturePath = fileURLToPath(
  new URL(
    "../../../fixtures/v0.1/usdc-transfer-checked-finalized.json",
    import.meta.url,
  ),
);
const signature =
  "2Ana1pUpv2ZbMVkwF5FXapYeBEjdxDatLn7nvJkhgTSXbs59SyZSx866bXirPgj8QQVB57uxHJBG1YFvkRbFj4T";
let transaction: RpcTransactionEnvelope;

function candidate(
  overrides: Partial<FinalityCandidate> = {},
): FinalityCandidate {
  return {
    providerId: "primary",
    watchTargetId: "watch-1",
    cluster: "mainnet-beta",
    signature,
    slot: 100n,
    state: "confirmed",
    confirmedDigest: createParsingDigest(transaction),
    missingObservationCount: 0,
    firstMissingFinalizedSlot: null,
    claimToken: "claim-token",
    hasFinalizedSnapshot: false,
    ...overrides,
  };
}

beforeAll(async () => {
  transaction = PaymentFixtureSchema.parse(
    JSON.parse(await readFile(fixturePath, "utf8")),
  ).rpcTransaction;
});

describe("createFinalityEngine", () => {
  it("promotes matching finalized transaction evidence", async () => {
    const rpc = new FakeRpc();
    const store = new MemoryStore();
    store.finalityCandidates = [candidate()];
    rpc.currentSlot = 200n;
    rpc.statuses = [
      {
        signature,
        slot: 100n,
        confirmationStatus: "finalized",
        err: null,
      },
    ];
    rpc.transactions.set(signature, transaction);

    const report = await createFinalityEngine({ rpc, store }).refresh({
      providerId: "primary",
      limit: 10,
      now: new Date("2026-08-06T00:00:00Z"),
    });

    expect(report).toMatchObject({ observationsChecked: 1, finalized: 1 });
    expect(store.finalityObservations[0]?.nextState).toBe("finalized");
  });

  it("marks a non-null chain error failed", async () => {
    const rpc = new FakeRpc();
    const store = new MemoryStore();
    store.finalityCandidates = [candidate()];
    rpc.statuses = [
      {
        signature,
        slot: 100n,
        confirmationStatus: "finalized",
        err: { InstructionError: [0, "Custom"] },
      },
    ];

    const report = await createFinalityEngine({ rpc, store }).refresh({
      providerId: "primary",
      limit: 10,
      now: new Date("2026-08-06T00:00:00Z"),
    });

    expect(report.failed).toBe(1);
    expect(store.finalityObservations[0]?.nextState).toBe("failed");
  });

  it("defers one missing history status", async () => {
    const rpc = new FakeRpc();
    const store = new MemoryStore();
    store.finalityCandidates = [candidate()];
    rpc.currentSlot = 200n;
    rpc.statuses = [null];

    const report = await createFinalityEngine({ rpc, store }).refresh({
      providerId: "primary",
      limit: 10,
      now: new Date("2026-08-06T00:00:00Z"),
    });

    expect(report.deferred).toBe(1);
    expect(report.retriesCreated).toBe(0);
    expect(store.finalityObservations[0]).toMatchObject({
      nextState: "confirmed",
      code: "finality_status_missing",
    });
  });

  it("marks reversion only after bounded missing evidence", async () => {
    const rpc = new FakeRpc();
    const store = new MemoryStore();
    store.finalityCandidates = [
      candidate({
        missingObservationCount: 2,
        firstMissingFinalizedSlot: 120n,
      }),
    ];
    rpc.currentSlot = 200n;
    rpc.statuses = [null];
    rpc.transactions.set(signature, null);

    const report = await createFinalityEngine({ rpc, store }).refresh({
      providerId: "primary",
      limit: 10,
      now: new Date("2026-08-06T00:00:00Z"),
    });

    expect(report.reverted).toBe(1);
    expect(store.finalityObservations[0]?.nextState).toBe("reverted");
  });

  it("does not mark a transaction reverted when finalized raw evidence exists", async () => {
    const rpc = new FakeRpc();
    const store = new MemoryStore();
    store.finalityCandidates = [
      candidate({
        missingObservationCount: 2,
        firstMissingFinalizedSlot: 120n,
        hasFinalizedSnapshot: true,
      }),
    ];
    rpc.currentSlot = 200n;
    rpc.statuses = [null];
    rpc.transactions.set(signature, null);

    const report = await createFinalityEngine({ rpc, store }).refresh({
      providerId: "primary",
      limit: 10,
      now: new Date("2026-08-06T00:00:00Z"),
    });

    expect(report.reverted).toBe(0);
    expect(report.deferred).toBe(1);
    expect(report.retriesCreated).toBe(0);
    expect(store.finalityObservations[0]?.nextState).toBe("confirmed");
  });

  it("persists retry work when the status batch fails", async () => {
    const rpc = new FakeRpc();
    const store = new MemoryStore();
    store.finalityCandidates = [candidate()];
    rpc.statusError = new IngestionError(
      "rpc_transport_error",
      "provider unavailable",
      { retryable: true },
    );

    await expect(
      createFinalityEngine({ rpc, store }).refresh({
        providerId: "primary",
        limit: 10,
        now: new Date("2026-08-06T00:00:00Z"),
      }),
    ).rejects.toMatchObject({ code: "rpc_transport_error" });
    expect(store.retries[0]).toMatchObject({
      runId: null,
      watchTargetId: "watch-1",
      signature,
      operation: "finality",
      code: "rpc_transport_error",
    });
  });

  it("persists retry work when finalized transaction history fails", async () => {
    const rpc = new FakeRpc();
    const store = new MemoryStore();
    store.finalityCandidates = [candidate()];
    rpc.statuses = [
      {
        signature,
        slot: 100n,
        confirmationStatus: "finalized",
        err: null,
      },
    ];
    rpc.transactions.set(
      signature,
      new IngestionError("rpc_transport_error", "provider unavailable", {
        retryable: true,
      }),
    );

    const report = await createFinalityEngine({ rpc, store }).refresh({
      providerId: "primary",
      limit: 10,
      now: new Date("2026-08-06T00:00:00Z"),
    });

    expect(report.deferred).toBe(1);
    expect(report.retriesCreated).toBe(1);
    expect(store.retries[0]).toMatchObject({
      runId: null,
      signature,
      operation: "finality",
      code: "rpc_transport_error",
    });
    expect(store.finalityObservations[0]?.blockingRetry).toBe(true);
  });

  it("creates blocking retry work when finalized history returns null", async () => {
    const rpc = new FakeRpc();
    const store = new MemoryStore();
    store.finalityCandidates = [candidate()];
    rpc.statuses = [
      {
        signature,
        slot: 100n,
        confirmationStatus: "finalized",
        err: null,
      },
    ];
    rpc.transactions.set(signature, null);

    const report = await createFinalityEngine({ rpc, store }).refresh({
      providerId: "primary",
      limit: 10,
      now: new Date("2026-08-06T00:00:00Z"),
    });

    expect(report).toMatchObject({ deferred: 1, retriesCreated: 1 });
    expect(store.retries[0]).toMatchObject({
      operation: "finality",
      code: "finality_status_missing",
    });
    expect(store.finalityObservations[0]?.blockingRetry).toBe(true);
  });
});
