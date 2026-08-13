import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  PaymentFixtureSchema,
  type RpcTransactionEnvelope,
} from "@payops/core";
import { beforeAll, describe, expect, it } from "vitest";
import {
  FinalizedConsensusEngine,
  HttpSolanaRpc,
  IngestionError,
  type CompleteFinalizedConsensusInput,
  type FinalizedConsensusClaim,
  type FinalizedConsensusStore,
  type SolanaRpcPort,
} from "../src/index.js";
import { FakeRpc } from "./support/fake-rpc.js";

const fixturePath = fileURLToPath(
  new URL(
    "../../../fixtures/v0.1/usdc-transfer-checked-finalized.json",
    import.meta.url,
  ),
);
const signature =
  "2Ana1pUpv2ZbMVkwF5FXapYeBEjdxDatLn7nvJkhgTSXbs59SyZSx866bXirPgj8QQVB57uxHJBG1YFvkRbFj4T";
let transaction: RpcTransactionEnvelope;

class MemoryConsensusStore implements FinalizedConsensusStore {
  public readonly completions: CompleteFinalizedConsensusInput[] = [];
  public claimCount = 0;
  public settled: "agreed" | "disagreed" | null = null;

  public async claimFinalizedConsensus(): Promise<FinalizedConsensusClaim> {
    this.claimCount += 1;
    if (this.settled !== null) {
      return { kind: "settled", state: this.settled, generation: 1 };
    }
    return {
      kind: "claimed",
      organizationId: "00000000-0000-4000-8000-000000000001",
      cluster: "mainnet-beta",
      signature,
      generation: 1,
      primaryProviderId: "primary",
      secondaryProviderId: "secondary",
      claimToken: "00000000-0000-4000-8000-000000000002",
    };
  }

  public async completeFinalizedConsensus(
    input: CompleteFinalizedConsensusInput,
  ) {
    this.completions.push(input);
    return {
      applied: true,
      state: input.state,
      generation: input.claim.generation,
    } as const;
  }
}

beforeAll(async () => {
  transaction = PaymentFixtureSchema.parse(
    JSON.parse(await readFile(fixturePath, "utf8")),
  ).rpcTransaction;
});

describe("FinalizedConsensusEngine", () => {
  it("agrees only after independently fetching matching finalized evidence", async () => {
    const primary = finalizedRpc();
    const secondary = finalizedRpc();
    const store = new MemoryConsensusStore();
    const engine = new FinalizedConsensusEngine({
      store,
      rpcForProvider: (providerId) =>
        providerId === "primary" ? primary : secondary,
    });

    const result = await engine.verify({
      primaryProviderId: "primary",
      secondaryProviderId: "secondary",
      signature,
      now: new Date("2026-08-12T12:00:00.000Z"),
    });

    expect(result).toEqual({ state: "agreed", generation: 1, applied: true });
    expect(primary.transactionRequests).toEqual([signature]);
    expect(secondary.transactionRequests).toEqual([signature]);
    expect(store.completions[0]?.observations).toHaveLength(2);
    expect(
      store.completions[0]?.observations.map((entry) => entry.providerId),
    ).toEqual(["primary", "secondary"]);
  });

  it("ignores harmless raw JSON key insertion order", async () => {
    const primary = finalizedRpc();
    const secondary = finalizedRpc();
    secondary.transactions.set(signature, reverseObjectKeys(transaction));

    await expect(
      createEngine(primary, secondary).verify(input()),
    ).resolves.toEqual({ state: "agreed", generation: 1, applied: true });
  });

  it.each([
    [
      "slot",
      (rpc: FakeRpc) => {
        const changed = structuredClone(transaction);
        changed.slot += 1;
        rpc.transactions.set(signature, changed);
        rpc.statuses = [finalizedStatus(BigInt(changed.slot))];
      },
    ],
    [
      "snapshot content",
      (rpc: FakeRpc) => {
        const changed = structuredClone(transaction);
        changed.blockTime = (changed.blockTime ?? 0) + 1;
        rpc.transactions.set(signature, changed);
      },
    ],
    [
      "execution result",
      (rpc: FakeRpc) => {
        const changed = structuredClone(transaction);
        changed.meta.err = { InstructionError: [0, "Custom"] };
        rpc.transactions.set(signature, changed);
        rpc.statuses = [
          {
            ...finalizedStatus(),
            err: { InstructionError: [0, "Custom"] },
          },
        ];
      },
    ],
    [
      "normalized transfer identity",
      (rpc: FakeRpc) => {
        const changed = structuredClone(transaction);
        changed.transaction.message.accountKeys[2] =
          "11111111111111111111111111111111";
        rpc.transactions.set(signature, changed);
      },
    ],
    [
      "finality",
      (rpc: FakeRpc) => {
        rpc.statuses = [
          { ...finalizedStatus(), confirmationStatus: "confirmed" },
        ];
      },
    ],
  ])("durably disagrees on a %s mismatch", async (_name, changeSecondary) => {
    const primary = finalizedRpc();
    const secondary = finalizedRpc();
    changeSecondary(secondary);

    await expect(
      createEngine(primary, secondary).verify(input()),
    ).resolves.toEqual({ state: "disagreed", generation: 1, applied: true });
  });

  it("persists each provider's status and transaction slots separately", async () => {
    const primary = finalizedRpc();
    const secondary = finalizedRpc();
    const mismatchedStatusSlot = BigInt(transaction.slot) + 1n;
    primary.statuses = [finalizedStatus(mismatchedStatusSlot)];
    secondary.statuses = [finalizedStatus(mismatchedStatusSlot)];
    const store = new MemoryConsensusStore();

    await expect(
      createEngine(primary, secondary, store).verify(input()),
    ).resolves.toEqual({ state: "disagreed", generation: 1, applied: true });
    expect(store.completions[0]?.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          statusSlot: mismatchedStatusSlot,
          slot: BigInt(transaction.slot),
        }),
      ]),
    );
  });

  it("persists each provider's status and transaction execution digests separately", async () => {
    const primary = finalizedRpc();
    const secondary = finalizedRpc();
    const statusError = { InstructionError: [0, "Custom"] };
    primary.statuses = [{ ...finalizedStatus(), err: statusError }];
    secondary.statuses = [{ ...finalizedStatus(), err: statusError }];
    const store = new MemoryConsensusStore();

    await expect(
      createEngine(primary, secondary, store).verify(input()),
    ).resolves.toEqual({ state: "disagreed", generation: 1, applied: true });
    for (const observation of store.completions[0]?.observations ?? []) {
      expect(observation.statusExecutionDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(observation.transactionExecutionDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(observation.statusExecutionDigest).not.toBe(
        observation.transactionExecutionDigest,
      );
    }
  });

  it.each([
    ["missing transaction", null],
    [
      "rate limit",
      new IngestionError("rpc_rate_limited", "rate limited", {
        retryable: true,
      }),
    ],
  ])("keeps a %s secondary response pending", async (_name, response) => {
    const primary = finalizedRpc();
    const secondary = finalizedRpc();
    if (response === null) {
      secondary.transactions.set(signature, null);
    } else {
      secondary.statusError = response;
    }
    const store = new MemoryConsensusStore();

    await expect(
      createEngine(primary, secondary, store).verify(input()),
    ).resolves.toEqual({ state: "pending", generation: 1, applied: true });
    expect(store.completions[0]?.observations[1]).toMatchObject({
      canonicalDigest: null,
      safeErrorCode:
        response === null ? "finality_status_missing" : "rpc_rate_limited",
    });
  });

  it("rejects one provider filling both roles before any RPC request", async () => {
    const rpc = finalizedRpc();
    const store = new MemoryConsensusStore();

    await expect(
      createEngine(rpc, rpc, store).verify({
        ...input(),
        secondaryProviderId: "primary",
      }),
    ).rejects.toMatchObject({
      code: "invalid_configuration",
      retryable: false,
    });
    expect(store.claimCount).toBe(0);
    expect(rpc.transactionRequests).toEqual([]);
  });

  it("replays a durable terminal result without refetching providers", async () => {
    const primary = finalizedRpc();
    const secondary = finalizedRpc();
    const store = new MemoryConsensusStore();
    store.settled = "agreed";

    await expect(
      createEngine(primary, secondary, store).verify(input()),
    ).resolves.toEqual({ state: "agreed", generation: 1, applied: false });
    expect(primary.transactionRequests).toEqual([]);
    expect(secondary.transactionRequests).toEqual([]);
    expect(store.completions).toEqual([]);
  });

  it("preserves a real adapter signature conflict as terminal disagreement", async () => {
    const primary = finalizedRpc();
    const rawTransaction = structuredClone(transaction) as Record<
      string,
      unknown
    >;
    delete rawTransaction.cluster;
    delete rawTransaction.commitment;
    delete rawTransaction.signature;
    const rawTransactionBody = rawTransaction.transaction as {
      signatures: string[];
    };
    rawTransactionBody.signatures[0] = "1".repeat(64);
    const secondary = new HttpSolanaRpc(
      { cluster: "mainnet-beta", endpoint: "https://rpc.invalid" },
      (async (_url, init) => {
        const request = JSON.parse(String(init?.body)) as { method: string };
        const result =
          request.method === "getSignatureStatuses"
            ? {
                context: { slot: transaction.slot },
                value: [
                  {
                    slot: transaction.slot,
                    err: transaction.meta.err,
                    confirmationStatus: "finalized",
                  },
                ],
              }
            : rawTransaction;
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
          status: 200,
        });
      }) as typeof fetch,
    );
    const store = new MemoryConsensusStore();

    await expect(
      createEngine(primary, secondary, store).verify(input()),
    ).resolves.toEqual({ state: "disagreed", generation: 1, applied: true });
    expect(store.completions[0]?.observations[1]).toMatchObject({
      canonicalDigest: null,
      safeErrorCode: "rpc_signature_conflict",
      safeErrorRetryable: false,
    });
  });

  it("keeps malformed non-null provider evidence pending", async () => {
    const primary = finalizedRpc();
    const secondary = new HttpSolanaRpc(
      { cluster: "mainnet-beta", endpoint: "https://rpc.invalid" },
      (async (_url, init) => {
        const request = JSON.parse(String(init?.body)) as { method: string };
        const result =
          request.method === "getSignatureStatuses"
            ? {
                context: { slot: transaction.slot },
                value: [
                  {
                    slot: transaction.slot,
                    err: transaction.meta.err,
                    confirmationStatus: "finalized",
                  },
                ],
              }
            : {};
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
          status: 200,
        });
      }) as typeof fetch,
    );
    const store = new MemoryConsensusStore();

    await expect(
      createEngine(primary, secondary, store).verify(input()),
    ).resolves.toEqual({ state: "pending", generation: 1, applied: true });
    expect(store.completions[0]?.observations[1]).toMatchObject({
      canonicalDigest: null,
      safeErrorCode: "rpc_transaction_schema_invalid",
      safeErrorRetryable: true,
    });
  });

  it("keeps hostile deeply nested status evidence pending", async () => {
    const primary = finalizedRpc();
    const rawTransaction = structuredClone(transaction) as Record<
      string,
      unknown
    >;
    delete rawTransaction.cluster;
    delete rawTransaction.commitment;
    delete rawTransaction.signature;
    let hostileErr: Record<string, unknown> = { value: "attacker-marker" };
    for (let depth = 0; depth < 80; depth += 1) {
      hostileErr = { nested: hostileErr };
    }
    const secondary = new HttpSolanaRpc(
      { cluster: "mainnet-beta", endpoint: "https://rpc.invalid" },
      (async (_url, init) => {
        const request = JSON.parse(String(init?.body)) as { method: string };
        const result =
          request.method === "getSignatureStatuses"
            ? {
                context: { slot: transaction.slot },
                value: [
                  {
                    slot: transaction.slot,
                    err: hostileErr,
                    confirmationStatus: "finalized",
                  },
                ],
              }
            : rawTransaction;
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
          status: 200,
        });
      }) as typeof fetch,
    );
    const store = new MemoryConsensusStore();

    await expect(
      createEngine(primary, secondary, store).verify(input()),
    ).resolves.toEqual({ state: "pending", generation: 1, applied: true });
    const persistedObservation = store.completions[0]?.observations[1];
    expect(persistedObservation).toMatchObject({
      canonicalDigest: null,
      safeErrorCode: "rpc_invalid_json",
      safeErrorRetryable: true,
    });
    expect(JSON.stringify(persistedObservation)).not.toContain(
      "attacker-marker",
    );
  });

  it.each([42, false, ["InstructionError", 0]])(
    "keeps malformed status error evidence %j pending",
    async (malformedError) => {
      const primary = finalizedRpc();
      const secondary = new HttpSolanaRpc(
        { cluster: "mainnet-beta", endpoint: "https://rpc.invalid" },
        (async (_url, init) => {
          const request = JSON.parse(String(init?.body)) as { method: string };
          const result =
            request.method === "getSignatureStatuses"
              ? {
                  context: { slot: transaction.slot },
                  value: [
                    {
                      slot: transaction.slot,
                      err: malformedError,
                      confirmationStatus: "finalized",
                    },
                  ],
                }
              : transaction;
          return new Response(
            JSON.stringify({ jsonrpc: "2.0", id: 1, result }),
            { status: 200 },
          );
        }) as typeof fetch,
      );
      const store = new MemoryConsensusStore();

      await expect(
        createEngine(primary, secondary, store).verify(input()),
      ).resolves.toEqual({ state: "pending", generation: 1, applied: true });
      expect(store.completions[0]?.observations[1]).toMatchObject({
        canonicalDigest: null,
        safeErrorCode: "rpc_invalid_json",
        safeErrorRetryable: true,
      });
    },
  );
});

describe("RPC consensus migration boundary", () => {
  it("defines tenant-scoped forced-RLS roles and immutable evidence", async () => {
    const migration = await readFile(
      new URL("../migrations/0004_rpc_consensus.sql", import.meta.url),
      "utf8",
    );

    for (const table of [
      "rpc_provider_roles",
      "rpc_consensus_checks",
      "rpc_consensus_provider_observations",
    ]) {
      expect(migration).toContain(
        `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`,
      );
      expect(migration).toContain(
        `ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`,
      );
    }
    expect(migration).toContain("payops_guard_rpc_consensus_check");
    expect(migration).toContain("payops_guard_rpc_consensus_observation");
    expect(migration).toContain("payops_guard_rpc_provider_role");
    expect(migration).toContain("FOREIGN KEY (provider_id, cluster)");
    expect(migration).toContain("UNIQUE (organization_id, cluster, role)");
    expect(migration).toContain(
      "UNIQUE (organization_id, cluster, provider_id)",
    );
  });
});

function finalizedRpc(): FakeRpc {
  const rpc = new FakeRpc();
  rpc.statuses = [finalizedStatus()];
  rpc.transactions.set(signature, structuredClone(transaction));
  return rpc;
}

function finalizedStatus(slot = BigInt(transaction.slot)) {
  return {
    signature,
    slot,
    confirmationStatus: "finalized" as const,
    err: transaction.meta.err,
  };
}

function input() {
  return {
    primaryProviderId: "primary",
    secondaryProviderId: "secondary",
    signature,
    now: new Date("2026-08-12T12:00:00.000Z"),
  } as const;
}

function createEngine(
  primary: SolanaRpcPort,
  secondary: SolanaRpcPort,
  store = new MemoryConsensusStore(),
): FinalizedConsensusEngine {
  return new FinalizedConsensusEngine({
    store,
    rpcForProvider: (providerId) =>
      providerId === "primary" ? primary : secondary,
  });
}

function reverseObjectKeys<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(reverseObjectKeys) as T;
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, entry]) => [key, reverseObjectKeys(entry)]),
    ) as T;
  }
  return value;
}
