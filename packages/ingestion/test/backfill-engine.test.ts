import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  PaymentFixtureSchema,
  type RpcTransactionEnvelope,
} from "@payops/core";
import { beforeAll, describe, expect, it } from "vitest";
import { createBackfillEngine, IngestionError } from "../src/index.js";
import { FakeRpc } from "./support/fake-rpc.js";
import { MemoryStore } from "./support/memory-store.js";

const fixturePath = fileURLToPath(
  new URL(
    "../../../fixtures/v0.1/usdc-transfer-checked-finalized.json",
    import.meta.url,
  ),
);
const newestSignature =
  "2Ana1pUpv2ZbMVkwF5FXapYeBEjdxDatLn7nvJkhgTSXbs59SyZSx866bXirPgj8QQVB57uxHJBG1YFvkRbFj4T";
const oldestSignature =
  "1111111111111111111111111111111111111111111111111111111111111111";
let canonical: RpcTransactionEnvelope;

function discovered(signature: string, slot: bigint) {
  return {
    signature,
    slot,
    blockTime: 1786000000n,
    err: null,
    confirmationStatus: "confirmed" as const,
  };
}

function transaction(signature: string, slot: number): RpcTransactionEnvelope {
  const value = structuredClone(canonical);
  value.signature = signature;
  value.transaction.signatures[0] = signature;
  value.slot = slot;
  return value;
}

beforeAll(async () => {
  canonical = PaymentFixtureSchema.parse(
    JSON.parse(await readFile(fixturePath, "utf8")),
  ).rpcTransaction;
});

describe("createBackfillEngine", () => {
  it("returns busy without making an RPC request", async () => {
    const rpc = new FakeRpc();
    const store = new MemoryStore();
    store.busy = true;

    const report = await createBackfillEngine({ rpc, store }).syncWatchTarget({
      providerId: "primary",
      watchTargetId: "watch-1",
      now: new Date("2026-08-06T00:00:00Z"),
    });

    expect(report.result).toBe("busy");
    expect(rpc.signatureRequests).toHaveLength(0);
  });

  it("captures a stable head and processes signatures oldest first", async () => {
    const rpc = new FakeRpc();
    const store = new MemoryStore();
    rpc.head = discovered(newestSignature, 12n);
    rpc.pages.set(newestSignature, [discovered(oldestSignature, 10n)]);
    rpc.pages.set(oldestSignature, []);
    rpc.transactions.set(newestSignature, transaction(newestSignature, 12));
    rpc.transactions.set(oldestSignature, transaction(oldestSignature, 10));

    const report = await createBackfillEngine({ rpc, store }).syncWatchTarget({
      providerId: "primary",
      watchTargetId: "watch-1",
      now: new Date("2026-08-06T00:00:00Z"),
    });

    expect(rpc.signatureRequests[1]?.before).toBe(newestSignature);
    expect(rpc.transactionRequests).toEqual([oldestSignature, newestSignature]);
    expect(report).toMatchObject({
      result: "complete",
      signaturesDiscovered: 2,
      signaturesStored: 2,
      eventsStored: 2,
      cursorAdvanced: true,
    });
    expect(store.watchTarget.committedHeadSignature).toBe(newestSignature);
    expect(store.released).toBe(1);
  });

  it("deduplicates overlapping pages and keeps same-slot processing stable", async () => {
    const rpc = new FakeRpc();
    const store = new MemoryStore();
    const sameSlotFirst = "same-slot-first";
    const sameSlotSecond = "same-slot-second";
    const oldest = "oldest";
    rpc.head = discovered(newestSignature, 12n);
    rpc.pages.set(newestSignature, [
      discovered(sameSlotFirst, 10n),
      discovered(sameSlotSecond, 10n),
    ]);
    rpc.pages.set(sameSlotSecond, [
      discovered(sameSlotFirst, 10n),
      discovered(oldest, 9n),
    ]);
    rpc.pages.set(oldest, []);
    for (const [signature, slot] of [
      [newestSignature, 12],
      [sameSlotFirst, 10],
      [sameSlotSecond, 10],
      [oldest, 9],
    ] as const) {
      rpc.transactions.set(signature, transaction(signature, slot));
    }

    const report = await createBackfillEngine({ rpc, store }).syncWatchTarget({
      providerId: "primary",
      watchTargetId: "watch-1",
      now: new Date("2026-08-06T00:00:00Z"),
    });

    expect(report.signaturesDiscovered).toBe(4);
    expect(rpc.transactionRequests).toEqual([
      oldest,
      sameSlotFirst,
      sameSlotSecond,
      newestSignature,
    ]);
  });

  it("filters the boundary page at the configured overlap floor", async () => {
    const rpc = new FakeRpc();
    const store = new MemoryStore();
    store.watchTarget = {
      ...store.watchTarget,
      committedHeadSlot: 300n,
      committedHeadSignature: "previous-head",
      overlapSlots: 150n,
    };
    const inOverlap = "in-overlap";
    const belowFloor = "below-floor";
    rpc.head = discovered(newestSignature, 320n);
    rpc.pages.set(newestSignature, [
      discovered(inOverlap, 200n),
      discovered(belowFloor, 149n),
    ]);
    rpc.transactions.set(newestSignature, transaction(newestSignature, 320));
    rpc.transactions.set(inOverlap, transaction(inOverlap, 200));

    const report = await createBackfillEngine({ rpc, store }).syncWatchTarget({
      providerId: "primary",
      watchTargetId: "watch-1",
      now: new Date("2026-08-06T00:00:00Z"),
    });

    expect(report.signaturesDiscovered).toBe(2);
    expect(rpc.transactionRequests).toEqual([inOverlap, newestSignature]);
    expect(rpc.transactionRequests).not.toContain(belowFloor);
  });

  it("blocks cursor advancement when a history page increases by slot", async () => {
    const rpc = new FakeRpc();
    const store = new MemoryStore();
    rpc.head = discovered(newestSignature, 12n);
    rpc.pages.set(newestSignature, [
      discovered("older", 9n),
      discovered("newer", 10n),
    ]);

    const report = await createBackfillEngine({ rpc, store }).syncWatchTarget({
      providerId: "primary",
      watchTargetId: "watch-1",
      now: new Date("2026-08-06T00:00:00Z"),
    });

    expect(report).toMatchObject({
      result: "incomplete",
      cursorAdvanced: false,
    });
    expect(store.retries.at(-1)?.code).toBe("rpc_page_order_invalid");
  });

  it("keeps the previous cursor when a transaction is temporarily missing", async () => {
    const rpc = new FakeRpc();
    const store = new MemoryStore();
    rpc.head = discovered(newestSignature, 12n);
    rpc.pages.set(newestSignature, []);
    rpc.transactions.set(newestSignature, null);

    const report = await createBackfillEngine({ rpc, store }).syncWatchTarget({
      providerId: "primary",
      watchTargetId: "watch-1",
      now: new Date("2026-08-06T00:00:00Z"),
    });

    expect(report).toMatchObject({
      result: "incomplete",
      cursorAdvanced: false,
    });
    expect(store.retries[0]).toMatchObject({
      signature: newestSignature,
      code: "rpc_transaction_missing",
    });
    expect(store.watchTarget.committedHeadSignature).toBeNull();
  });

  it("persists discovery before transaction retrieval and resolves the retry on recovery", async () => {
    const rpc = new FakeRpc();
    const store = new MemoryStore();
    rpc.head = discovered(newestSignature, 12n);
    rpc.pages.set(newestSignature, []);
    rpc.transactions.set(newestSignature, null);
    const engine = createBackfillEngine({ rpc, store });
    const input = {
      providerId: "primary",
      watchTargetId: "watch-1",
      now: new Date("2026-08-06T00:00:00Z"),
    };

    const first = await engine.syncWatchTarget(input);

    expect(first.cursorAdvanced).toBe(false);
    expect(store.representations[0]?.classification).toBe("pending");
    expect(store.openRetry("transaction", newestSignature)).toBe(true);

    rpc.transactions.set(newestSignature, transaction(newestSignature, 12));
    const second = await engine.syncWatchTarget(input);

    expect(second.result).toBe("complete");
    expect(store.openRetry("transaction", newestSignature)).toBe(false);
    expect(store.representations.map((entry) => entry.classification)).toEqual([
      "pending",
      "pending",
      "parsed",
    ]);
  });

  it("resolves a page retry after a later complete pagination pass", async () => {
    const rpc = new FakeRpc();
    const store = new MemoryStore();
    rpc.head = discovered(newestSignature, 12n);
    rpc.pages.set(newestSignature, [discovered(newestSignature, 12n)]);
    const engine = createBackfillEngine({ rpc, store });
    const input = {
      providerId: "primary",
      watchTargetId: "watch-1",
      now: new Date("2026-08-06T00:00:00Z"),
    };

    await engine.syncWatchTarget(input);
    expect(store.openRetry("page", null)).toBe(true);

    rpc.pages.set(newestSignature, []);
    rpc.transactions.set(newestSignature, transaction(newestSignature, 12));
    const recovered = await engine.syncWatchTarget(input);

    expect(recovered.result).toBe("complete");
    expect(store.openRetry("page", null)).toBe(false);
  });

  it("classifies a page persistence failure as storage work and recovers", async () => {
    const rpc = new FakeRpc();
    const store = new MemoryStore();
    rpc.head = discovered(newestSignature, 12n);
    rpc.pages.set(newestSignature, [discovered(oldestSignature, 10n)]);
    rpc.pages.set(oldestSignature, []);
    rpc.transactions.set(newestSignature, transaction(newestSignature, 12));
    rpc.transactions.set(oldestSignature, transaction(oldestSignature, 10));
    store.failNextRecordPage = true;
    const engine = createBackfillEngine({ rpc, store });
    const input = {
      providerId: "primary",
      watchTargetId: "watch-1",
      now: new Date("2026-08-06T00:00:00Z"),
    };

    const failed = await engine.syncWatchTarget(input);

    expect(failed).toMatchObject({
      result: "incomplete",
      cursorAdvanced: false,
    });
    expect(store.retries.at(-1)).toMatchObject({
      operation: "storage",
      signature: null,
      code: "database_unavailable",
    });

    const recovered = await engine.syncWatchTarget(input);

    expect(recovered.result).toBe("complete");
    expect(store.openRetry("storage", null)).toBe(false);
  });

  it("keeps the cursor stable when final representation storage fails", async () => {
    const rpc = new FakeRpc();
    const store = new MemoryStore();
    rpc.head = discovered(newestSignature, 12n);
    rpc.pages.set(newestSignature, []);
    rpc.transactions.set(newestSignature, transaction(newestSignature, 12));
    store.failNextFinalRepresentation = true;
    const engine = createBackfillEngine({ rpc, store });
    const input = {
      providerId: "primary",
      watchTargetId: "watch-1",
      now: new Date("2026-08-06T00:00:00Z"),
    };

    const failed = await engine.syncWatchTarget(input);

    expect(failed).toMatchObject({
      result: "incomplete",
      cursorAdvanced: false,
    });
    expect(store.retries.at(-1)).toMatchObject({
      operation: "storage",
      signature: newestSignature,
      code: "database_unavailable",
    });
    expect(store.watchTarget.committedHeadSignature).toBeNull();

    const recovered = await engine.syncWatchTarget(input);

    expect(recovered.result).toBe("complete");
    expect(store.openRetry("storage", newestSignature)).toBe(false);
  });

  it("quarantines unsafe evidence but advances the durable cursor", async () => {
    const rpc = new FakeRpc();
    const store = new MemoryStore();
    rpc.head = discovered(newestSignature, 12n);
    rpc.pages.set(newestSignature, []);
    const unsafe = transaction(newestSignature, 12);
    const instruction = unsafe.transaction.message.instructions[0];
    const balance = unsafe.meta.postTokenBalances[1];
    if (instruction === undefined || balance === undefined) {
      throw new Error("Expected transfer fixture evidence");
    }
    instruction.accounts = [1, 2, 0, 5];
    instruction.data = "3Jw9y63HdCBH";
    balance.mint = "Es9vMFrzaCERmJfrF4H2FYD6Ew8VxRbjgVq2mL2FWV1";
    rpc.transactions.set(newestSignature, unsafe);

    const report = await createBackfillEngine({ rpc, store }).syncWatchTarget({
      providerId: "primary",
      watchTargetId: "watch-1",
      now: new Date("2026-08-06T00:00:00Z"),
    });

    expect(report).toMatchObject({
      result: "incomplete",
      quarantinesCreated: 1,
      cursorAdvanced: true,
    });
    expect(store.representations.at(-1)?.classification).toBe("quarantined");
    expect(store.watchTarget.coverage).toBe("incomplete");
  });

  it("quarantines Token-2022 activity instead of labeling it irrelevant", async () => {
    const rpc = new FakeRpc();
    const store = new MemoryStore();
    rpc.head = discovered(newestSignature, 12n);
    rpc.pages.set(newestSignature, []);
    const token2022 = transaction(newestSignature, 12);
    token2022.transaction.message.accountKeys[4] =
      "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
    rpc.transactions.set(newestSignature, token2022);

    const report = await createBackfillEngine({ rpc, store }).syncWatchTarget({
      providerId: "primary",
      watchTargetId: "watch-1",
      now: new Date("2026-08-06T00:00:00Z"),
    });

    expect(report).toMatchObject({
      result: "incomplete",
      quarantinesCreated: 1,
      cursorAdvanced: true,
    });
    expect(store.representations.at(-1)).toMatchObject({
      classification: "quarantined",
      quarantineMessage: "Token-2022 instructions are not supported",
    });
  });

  it("rejects a page that repeats its boundary and releases the lock", async () => {
    const rpc = new FakeRpc();
    const store = new MemoryStore();
    rpc.head = discovered(newestSignature, 12n);
    rpc.pages.set(newestSignature, [discovered(newestSignature, 12n)]);

    const report = await createBackfillEngine({ rpc, store }).syncWatchTarget({
      providerId: "primary",
      watchTargetId: "watch-1",
      now: new Date("2026-08-06T00:00:00Z"),
    });

    expect(report.result).toBe("incomplete");
    expect(store.retries[0]?.code).toBe("rpc_page_no_progress");
    expect(store.released).toBe(1);
  });

  it("records a retryable transport error without leaking the thrown message", async () => {
    const rpc = new FakeRpc();
    const store = new MemoryStore();
    rpc.head = discovered(newestSignature, 12n);
    rpc.pages.set(newestSignature, []);
    rpc.transactions.set(
      newestSignature,
      new IngestionError("rpc_transport_error", "provider unavailable", {
        retryable: true,
      }),
    );

    const report = await createBackfillEngine({ rpc, store }).syncWatchTarget({
      providerId: "primary",
      watchTargetId: "watch-1",
      now: new Date("2026-08-06T00:00:00Z"),
    });

    expect(report.result).toBe("incomplete");
    expect(store.retries[0]?.code).toBe("rpc_transport_error");
  });
});
