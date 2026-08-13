import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";
import type { CompleteFinalizedConsensusInput } from "../src/domain/types.js";
import {
  claimFinalizedConsensus,
  completeFinalizedConsensus,
} from "../src/storage/consensus-store.js";

const organizationId = "00000000-0000-4000-8000-000000000001";
const now = new Date("2026-08-12T12:00:00.000Z");
const signature = "s".repeat(64);

describe("consensus storage timestamps", () => {
  it("decodes canonical persisted timestamps and rejects malformed values", async () => {
    await expect(
      claimFinalizedConsensus(
        consensusSql("2026-08-12T12:00:00.000Z"),
        organizationId,
        claimInput(),
      ),
    ).resolves.toMatchObject({ kind: "claimed", generation: 1 });

    await expect(
      claimFinalizedConsensus(
        consensusSql("not-a-timestamp"),
        organizationId,
        claimInput(),
      ),
    ).rejects.toMatchObject({
      code: "database_unavailable",
      message: "Stored consensus timestamp is invalid",
      retryable: false,
    });
  });

  it("does not send the caller clock as lease authority", async () => {
    const callerNow = new Date("2099-01-01T00:00:00.000Z");
    const recordedValues: unknown[] = [];

    await claimFinalizedConsensus(
      consensusSql("2026-08-12T12:01:00.000Z", recordedValues),
      organizationId,
      { ...claimInput(), now: callerNow },
    );

    expect(recordedValues).not.toContain(callerNow.toISOString());
  });

  it("rejects completion when the database says the lease expired", async () => {
    await expect(
      completeFinalizedConsensus(
        completionSql({ leaseActive: false }),
        completionInput(),
      ),
    ).resolves.toEqual({ applied: false, state: "pending", generation: 1 });
  });

  it("accepts completion at the exact database lease boundary", async () => {
    await expect(
      completeFinalizedConsensus(
        completionSql({ leaseActive: true }),
        completionInput(),
      ),
    ).resolves.toEqual({ applied: true, state: "agreed", generation: 1 });
  });

  it("rolls back when the database lease expires during persistence", async () => {
    await expect(
      completeFinalizedConsensus(
        completionSql({
          leaseActive: true,
          derivedState: "agreed",
          finalUpdateApplied: false,
        }),
        completionInput(),
      ),
    ).resolves.toEqual({ applied: false, state: "pending", generation: 1 });
  });

  it("fails closed when retryable missing evidence is called disagreed", async () => {
    await expect(
      completeFinalizedConsensus(
        completionSql({ leaseActive: true, derivedState: "pending" }),
        completionInput({
          state: "disagreed",
          secondaryErrorCode: "rpc_rate_limited",
        }),
      ),
    ).rejects.toMatchObject({
      code: "invalid_configuration",
      retryable: false,
    });
  });

  it("fails closed when a terminal provider conflict is called pending", async () => {
    await expect(
      completeFinalizedConsensus(
        completionSql({ leaseActive: true, derivedState: "disagreed" }),
        completionInput({
          state: "pending",
          secondaryErrorCode: "rpc_signature_conflict",
        }),
      ),
    ).rejects.toMatchObject({
      code: "invalid_configuration",
      retryable: false,
    });
  });

  it("fails closed when locked provider IDs do not match the claim", async () => {
    await expect(
      completeFinalizedConsensus(
        completionSql({
          leaseActive: true,
          persistedPrimaryProviderId: "replacement-primary",
        }),
        completionInput(),
      ),
    ).rejects.toMatchObject({
      code: "invalid_configuration",
      retryable: false,
    });
  });

  it.each([-1n, 18_446_744_073_709_551_616n])(
    "rejects out-of-range status slot %s before persistence",
    async (statusSlot) => {
      const input = completionInput();
      await expect(
        completeFinalizedConsensus(completionSql({ leaseActive: true }), {
          ...input,
          observations: [
            { ...input.observations[0]!, statusSlot },
            input.observations[1]!,
          ],
        }),
      ).rejects.toMatchObject({
        code: "invalid_configuration",
        message: "Consensus completion evidence is invalid",
        retryable: false,
      });
    },
  );

  it("rejects complete evidence that omits an internal component", async () => {
    const input = completionInput();
    const { statusSlot: _statusSlot, ...incomplete } = input.observations[0]!;

    await expect(
      completeFinalizedConsensus(completionSql({ leaseActive: true }), {
        ...input,
        observations: [incomplete, input.observations[1]!],
      } as unknown as CompleteFinalizedConsensusInput),
    ).rejects.toMatchObject({
      code: "invalid_configuration",
      message: "Consensus completion evidence is invalid",
      retryable: false,
    });
  });

  it.each([
    [
      "oversized finality",
      () => {
        const input = completionInput();
        return {
          ...input,
          observations: [
            { ...input.observations[0]!, finality: "x".repeat(33) },
            input.observations[1]!,
          ],
        } as CompleteFinalizedConsensusInput;
      },
    ],
    [
      "invalid observation timestamp",
      () => {
        const input = completionInput();
        return {
          ...input,
          observations: [
            { ...input.observations[0]!, observedAt: new Date(Number.NaN) },
            input.observations[1]!,
          ],
        } as CompleteFinalizedConsensusInput;
      },
    ],
    [
      "unbounded error code",
      () => {
        const input = completionInput({
          state: "pending",
          secondaryErrorCode: "rpc_rate_limited",
        });
        return {
          ...input,
          observations: [
            input.observations[0]!,
            {
              ...input.observations[1]!,
              safeErrorCode: "attacker-message",
            },
          ],
        } as unknown as CompleteFinalizedConsensusInput;
      },
    ],
    [
      "retryable terminal conflict",
      () => {
        const input = completionInput({
          state: "pending",
          secondaryErrorCode: "rpc_signature_conflict",
        });
        return {
          ...input,
          observations: [
            input.observations[0]!,
            { ...input.observations[1]!, safeErrorRetryable: true },
          ],
        } as CompleteFinalizedConsensusInput;
      },
    ],
  ])("rejects %s before persistence", async (_name, input) => {
    await expect(
      completeFinalizedConsensus(
        completionSql({ leaseActive: true, derivedState: input().state }),
        input(),
      ),
    ).rejects.toMatchObject({
      code: "invalid_configuration",
      message: "Consensus completion evidence is invalid",
      retryable: false,
    });
  });
});

function claimInput() {
  return {
    primaryProviderId: "primary",
    secondaryProviderId: "secondary",
    signature,
    now,
  } as const;
}

function consensusSql(
  claimedUntil: unknown,
  recordedValues: unknown[] = [],
): Sql {
  const check = {
    id: "1",
    organization_id: organizationId,
    cluster: "mainnet-beta",
    signature,
    generation: 1,
    primary_provider_id: "primary",
    secondary_provider_id: "secondary",
    state: "pending",
    claim_token: "00000000-0000-4000-8000-000000000002",
    claimed_until: claimedUntil,
    started_at: "2026-08-12T11:59:00.000Z",
    completed_at: null,
    lease_active: true,
  };
  const results: readonly unknown[][] = [
    [
      {
        organization_id: organizationId,
        cluster: "mainnet-beta",
        role: "primary",
        provider_id: "primary",
        created_at: now,
      },
      {
        organization_id: organizationId,
        cluster: "mainnet-beta",
        role: "secondary",
        provider_id: "secondary",
        created_at: now,
      },
    ],
    [],
    [check],
    [check],
  ];
  let queryIndex = 0;
  const transaction = ((
    _strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    recordedValues.push(...values);
    return Promise.resolve(results[queryIndex++] ?? []);
  }) as unknown as Sql;
  return {
    begin: async <T>(callback: (sql: Sql) => Promise<T>) =>
      callback(transaction),
  } as unknown as Sql;
}

function completionInput(
  options: {
    readonly state?: "pending" | "agreed" | "disagreed";
    readonly secondaryErrorCode?: "rpc_rate_limited" | "rpc_signature_conflict";
  } = {},
) {
  const observation = (providerId: string) => ({
    providerId,
    canonicalDigest: "a".repeat(64),
    snapshotDigest: "b".repeat(64),
    parsingDigest: "c".repeat(64),
    transferIdentityDigest: "d".repeat(64),
    statusSlot: 1n,
    slot: 1n,
    executionState: "succeeded" as const,
    executionDigest: "e".repeat(64),
    statusExecutionDigest: "f".repeat(64),
    transactionExecutionDigest: "f".repeat(64),
    finality: "finalized/finalized",
    responseTimeMs: 1,
    safeErrorCode: null,
    safeErrorRetryable: null,
    observedAt: new Date("2026-08-12T12:00:00.000Z"),
  });
  return {
    claim: {
      kind: "claimed" as const,
      organizationId,
      cluster: "mainnet-beta" as const,
      signature,
      generation: 1,
      primaryProviderId: "primary",
      secondaryProviderId: "secondary",
      claimToken: "00000000-0000-4000-8000-000000000002",
    },
    state: options.state ?? ("agreed" as const),
    observations: [
      observation("primary"),
      options.secondaryErrorCode === undefined
        ? observation("secondary")
        : {
            providerId: "secondary",
            canonicalDigest: null,
            snapshotDigest: null,
            parsingDigest: null,
            transferIdentityDigest: null,
            statusSlot: null,
            slot: null,
            executionState: null,
            executionDigest: null,
            statusExecutionDigest: null,
            transactionExecutionDigest: null,
            finality: null,
            responseTimeMs: 1,
            safeErrorCode: options.secondaryErrorCode,
            safeErrorRetryable:
              options.secondaryErrorCode === "rpc_rate_limited",
            observedAt: new Date("2026-08-12T12:00:00.000Z"),
          },
    ],
  };
}

function completionSql(options: {
  readonly leaseActive: boolean;
  readonly derivedState?: "pending" | "agreed" | "disagreed";
  readonly finalUpdateApplied?: boolean;
  readonly persistedPrimaryProviderId?: string;
}): Sql {
  const row = {
    id: "1",
    organization_id: organizationId,
    cluster: "mainnet-beta",
    signature,
    generation: 1,
    primary_provider_id: options.persistedPrimaryProviderId ?? "primary",
    secondary_provider_id: "secondary",
    state: "pending",
    claim_token: "00000000-0000-4000-8000-000000000002",
    claimed_until: "2026-08-12T12:01:00.000Z",
    started_at: "2026-08-12T12:00:00.000Z",
    completed_at: null,
    lease_active: options.leaseActive,
  };
  const results: readonly unknown[][] = [
    [],
    [row],
    [],
    [],
    [{ state: options.derivedState ?? "agreed" }],
    options.finalUpdateApplied === false
      ? []
      : [{ state: options.derivedState ?? "agreed" }],
  ];
  let queryIndex = 0;
  const transaction = (() =>
    Promise.resolve(results[queryIndex++] ?? [])) as unknown as Sql;
  return {
    begin: async <T>(callback: (sql: Sql) => Promise<T>) =>
      callback(transaction),
  } as unknown as Sql;
}
