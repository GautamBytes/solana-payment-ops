import { createHash, randomUUID } from "node:crypto";
import { stringifyCanonical } from "@payops/core";
import type {
  IngestionStore,
  ProviderRecord,
  SolanaRpcPort,
  WatchCoverageSummary,
  WatchTarget,
} from "@payops/ingestion";
import type {
  OperatorReconciliationStore,
  ReconciliationAuditStore,
  ReconciliationAuditSummary,
} from "@payops/reconciliation";
import { describe, expect, it } from "vitest";
import {
  createShadowAuditRunner,
  type BuildAuditArtifactsInput,
} from "../src/orchestration/run-shadow-audit.js";
import type {
  AuditArtifactSet,
  PilotManifest,
  RunShadowAuditInput,
} from "../src/domain/types.js";
import { PILOT_STAGES } from "../src/domain/types.js";
import type {
  ClaimedPilotStage,
  ClaimPilotStageInput,
  CompletePilotStageInput,
  CreatePilotRunInput,
  FailPilotStageInput,
  FinishPilotRunInput,
  PilotRunInspection,
  PilotRunRecord,
  PilotStageInspection,
  PilotStore,
  RecordPilotReportInput,
} from "../src/storage/types.js";

const now = new Date("2026-08-11T12:00:00.000Z");
const csv = [
  "invoice_id,customer_id,expected_mint,destination_token_account,amount_base_units,reference_address,issued_at,due_at",
  "invoice-001,customer-001,EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v,Cmn8RVNLZAtyq51B31RXDrrS24DYphEftzDCX4FzPLM,12500000,Gh5GixNvrU87vKWcLLLp6dcgBGRDtP4EJesFu6rjif4,2026-08-01T00:00:00Z,2026-08-15T00:00:00Z",
  "",
].join("\n");

describe("createShadowAuditRunner", () => {
  it("runs the exact six stages and persists their evidence", async () => {
    const context = makeContext();

    const result = await context.run(input());

    expect(context.pilot.completedStages).toEqual(PILOT_STAGES);
    expect(context.calls).toEqual([
      "configure:provider",
      "configure:watch",
      "import:1",
      "sync:treasury-primary",
      "reconcile",
      "report",
    ]);
    expect(result).toMatchObject({
      runId: context.pilot.runId,
      state: "complete",
      resumed: false,
      warnings: [],
    });
    expect(context.pilot.finishedState).toBe("complete");
    expect(context.pilot.reports).toHaveLength(4);
    expect(context.closed()).toEqual({
      pilot: 1,
      ingestion: 1,
      reconciliation: 1,
    });
  });

  it("skips existing successful stages", async () => {
    const context = makeContext({
      succeeded: ["configure", "import_invoices"],
    });

    const result = await context.run(input());

    expect(result.resumed).toBe(true);
    expect(context.calls).not.toContain("configure:provider");
    expect(context.calls).not.toContain("import:1");
    expect(context.calls).toContain("sync:treasury-primary");
  });

  it("returns a bounded incomplete result while another worker owns the stage", async () => {
    const context = makeContext({ busy: true });

    await expect(context.run(input())).resolves.toMatchObject({
      state: "incomplete",
      warnings: ["audit_busy"],
      privateArtifacts: [],
      redactedArtifacts: [],
    });
    expect(context.calls).toEqual([]);
    expect(context.closed()).toEqual({
      pilot: 1,
      ingestion: 1,
      reconciliation: 1,
    });
  });

  it("resumes at finality after a crash without repeating sync", async () => {
    const pilot = new MemoryPilotStore();
    const first = makeContext({ pilot, failFinalityOnce: true });

    await expect(first.run(input())).rejects.toMatchObject({
      code: "rpc_transport_error",
    });
    expect(first.calls).toContain("sync:treasury-primary");
    const second = makeContext({ pilot });

    const result = await second.run(input());

    expect(result.resumed).toBe(true);
    expect(second.calls).not.toContain("sync:treasury-primary");
    expect(second.calls).toContain("reconcile");
  });

  it("marks the audit incomplete when evidence coverage remains open", async () => {
    const context = makeContext({
      coverage: {
        coverage: "incomplete",
        pendingFinality: 1,
        retriesOpen: 2,
        quarantinesOpen: 3,
      },
      unmatchedFinalizedEvents: 1,
    });

    const result = await context.run(input());

    expect(result.state).toBe("incomplete");
    expect(result.warnings).toEqual([
      "coverage_incomplete",
      "finality_pending",
      "open_retries",
      "open_quarantines",
      "unclassified_finalized_value",
    ]);
    expect(context.pilot.finishedState).toBe("incomplete");
  });

  it("persists a safe reconciliation failure and closes every store", async () => {
    const context = makeContext({ failReconciliation: true });

    await expect(context.run(input())).rejects.toMatchObject({
      code: "database_unavailable",
      message: "Shadow audit stage failed",
    });
    expect(context.pilot.failedStage).toEqual({
      stage: "reconcile",
      errorCode: "database_unavailable",
    });
    expect(context.closed()).toEqual({
      pilot: 1,
      ingestion: 1,
      reconciliation: 1,
    });
  });
});

function makeContext(
  options: {
    readonly pilot?: MemoryPilotStore;
    readonly succeeded?: readonly (typeof PILOT_STAGES)[number][];
    readonly busy?: boolean;
    readonly failFinalityOnce?: boolean;
    readonly failReconciliation?: boolean;
    readonly coverage?: Partial<WatchCoverageSummary>;
    readonly unmatchedFinalizedEvents?: number;
  } = {},
) {
  const calls: string[] = [];
  const pilot = options.pilot ?? new MemoryPilotStore(options.succeeded);
  pilot.busy = options.busy ?? false;
  let pilotClosed = 0;
  let ingestionClosed = 0;
  let reconciliationClosed = 0;
  let finalityFailed = false;
  const providers = new Map<string, ProviderRecord>();
  const watches = new Map<string, WatchTarget>();
  if (pilot.isSucceeded("configure")) {
    const value = manifest();
    providers.set(value.provider.id, value.provider);
    const watch = value.watches[0]!;
    watches.set(watch.id, {
      id: watch.id,
      providerId: value.provider.id,
      cluster: value.provider.cluster,
      address: watch.tokenAccount,
      cutoverSlot: BigInt(watch.cutoverSlot),
      cutoverSignature: watch.cutoverSignature,
      overlapSlots: BigInt(watch.overlapSlots),
      committedHeadSlot: BigInt(watch.cutoverSlot),
      committedHeadSignature: watch.cutoverSignature,
      coverage: "complete",
    });
  }
  const coverage: WatchCoverageSummary = {
    watchTargetId: "treasury-primary",
    coverage: "complete",
    capturedHeadSlot: "350000000",
    committedHeadSlot: "350000000",
    signatures: 0,
    finalized: 0,
    pendingFinality: 0,
    retriesOpen: 0,
    quarantinesOpen: 0,
    ...options.coverage,
  };
  const ingestion = {
    async addProvider(value: ProviderRecord) {
      calls.push("configure:provider");
      providers.set(value.id, value);
      return value;
    },
    async getProvider(id: string) {
      return providers.get(id) ?? null;
    },
    async addWatchTarget(value: any) {
      calls.push("configure:watch");
      const target: WatchTarget = {
        ...value,
        committedHeadSlot: value.cutoverSlot,
        committedHeadSignature: value.cutoverSignature,
        coverage: "complete",
      };
      watches.set(value.id, target);
      return target;
    },
    async getWatchTarget(id: string) {
      return watches.get(id) ?? null;
    },
    async tryAcquireSyncLock() {
      return { release: async () => undefined };
    },
    async startSyncRun(value: { readonly watchTargetId: string }) {
      calls.push(`sync:${value.watchTargetId}`);
      return randomUUID();
    },
    async completeSyncRun() {
      return true;
    },
    async claimFinalityCandidates() {
      if (options.failFinalityOnce && !finalityFailed) {
        finalityFailed = true;
        throw Object.assign(new Error("unsafe rpc detail"), {
          code: "rpc_transport_error",
        });
      }
      return [];
    },
    async getWatchCoverageSummaries() {
      return [coverage];
    },
    async close() {
      ingestionClosed += 1;
    },
  } as unknown as IngestionStore & {
    getWatchCoverageSummaries(
      ids: readonly string[],
    ): Promise<readonly WatchCoverageSummary[]>;
  };
  const imported: any[] = [];
  const reconciliation = {
    async importInvoices(invoices: readonly any[]) {
      imported.push(...invoices);
      calls.push(`import:${invoices.length}`);
      return { inserted: invoices.length, existing: 0 };
    },
    async startRun() {
      calls.push("reconcile");
      if (options.failReconciliation) throw new Error("raw database detail");
      return randomUUID();
    },
    async listInvoices() {
      return imported;
    },
    async listFinalizedCandidates() {
      return [];
    },
    async recordDecision() {
      return false;
    },
    async completeRun() {},
    async getAuditSummary(): Promise<ReconciliationAuditSummary> {
      return {
        invoiceCount: imported.length,
        allocationCount: 0,
        exceptionCount: 0,
        exceptionsByCode: {},
        unmatchedFinalizedEvents: options.unmatchedFinalizedEvents ?? 0,
      };
    },
    async getAuditRows() {
      return [];
    },
    async close() {
      reconciliationClosed += 1;
    },
  } as unknown as OperatorReconciliationStore & ReconciliationAuditStore;
  const rpc: SolanaRpcPort = {
    getSignaturesForAddress: async () => [],
    getTransaction: async () => null,
    getSignatureStatuses: async () => [],
    getSlot: async () => 1n,
  };
  const artifacts = artifactSet([]);
  const run = createShadowAuditRunner({
    pilotStore: Object.assign(pilot, {
      close: async () => {
        pilotClosed += 1;
      },
    }),
    ingestionStore: ingestion,
    reconciliationStore: reconciliation,
    makeRpc: () => rpc,
    readInvoiceCsv: async () => csv,
    buildArtifacts: async (value: BuildAuditArtifactsInput) => {
      calls.push("report");
      return { ...artifacts, warnings: value.warnings };
    },
  });
  return {
    calls,
    pilot,
    run,
    closed: () => ({
      pilot: pilotClosed,
      ingestion: ingestionClosed,
      reconciliation: reconciliationClosed,
    }),
  };
}

class MemoryPilotStore implements PilotStore {
  public readonly runId = "b71f7d39-9bb4-4c37-a1ed-078601d8fd81";
  public readonly completedStages: string[] = [];
  public readonly reports: RecordPilotReportInput[] = [];
  public busy = false;
  public failedStage: { stage: string; errorCode: string } | null = null;
  public finishedState: string | null = null;
  readonly #stages: MutableStageInspection[];

  public constructor(succeeded: readonly string[] = []) {
    this.#stages = PILOT_STAGES.map((stage, index) => ({
      stage,
      ordinal: index + 1,
      state: succeeded.includes(stage) ? "succeeded" : "pending",
      result: succeeded.includes(stage) ? { ok: true } : null,
      errorCode: null,
      startedAt: succeeded.includes(stage) ? now : null,
      completedAt: succeeded.includes(stage) ? now : null,
    }));
  }

  public async getOrCreateRun(
    input: CreatePilotRunInput,
  ): Promise<PilotRunRecord> {
    return {
      id: this.runId,
      pilotId: input.pilotId,
      manifestDigest: input.manifestDigest,
      invoiceDigest: input.invoiceDigest,
      state:
        (this.finishedState as "complete" | "incomplete" | null) ?? "running",
      startedAt: now,
      completedAt: this.finishedState === null ? null : now,
    };
  }

  public isSucceeded(stage: string): boolean {
    return this.#stages.some(
      (value) => value.stage === stage && value.state === "succeeded",
    );
  }

  public async claimStage(
    _input: ClaimPilotStageInput,
  ): Promise<ClaimedPilotStage | null> {
    if (this.busy) return null;
    const stage = this.#stages.find((value) => value.state !== "succeeded");
    if (stage === undefined) return null;
    stage.state = "in_flight";
    stage.startedAt ??= now;
    return {
      runId: this.runId,
      stage: stage.stage,
      ordinal: stage.ordinal,
      leaseToken: randomUUID(),
      leaseExpiresAt: new Date(now.getTime() + 900_000),
      resumed: stage.errorCode !== null,
    };
  }

  public async completeStage(input: CompletePilotStageInput): Promise<boolean> {
    const stage = this.#stages.find((value) => value.stage === input.stage)!;
    stage.state = "succeeded";
    stage.result = input.result;
    stage.errorCode = null;
    stage.completedAt = input.completedAt;
    this.completedStages.push(input.stage);
    return true;
  }

  public async failStage(input: FailPilotStageInput): Promise<boolean> {
    const stage = this.#stages.find((value) => value.stage === input.stage)!;
    stage.state = "failed";
    stage.errorCode = input.errorCode;
    this.failedStage = { stage: input.stage, errorCode: input.errorCode };
    return true;
  }

  public async recordReport(input: RecordPilotReportInput): Promise<void> {
    this.reports.push(input);
  }

  public async finishRun(input: FinishPilotRunInput): Promise<boolean> {
    this.finishedState = input.state;
    return true;
  }

  public async getRun(): Promise<PilotRunInspection> {
    return {
      id: this.runId,
      pilotId: manifest().pilotId,
      manifestDigest: digest(stringifyCanonical(manifest())),
      invoiceDigest: digest(csv),
      state:
        (this.finishedState as "complete" | "incomplete" | null) ?? "running",
      startedAt: now,
      completedAt: this.finishedState === null ? null : now,
      stages: this.#stages,
      reports: this.reports,
    };
  }

  public async close(): Promise<void> {}
}

type MutableStageInspection = {
  -readonly [Key in keyof PilotStageInspection]: PilotStageInspection[Key];
};

function input(): RunShadowAuditInput {
  const value = manifest();
  const canonical = stringifyCanonical(value);
  return {
    manifest: value,
    manifestCanonicalJson: canonical,
    manifestDigest: digest(canonical),
    invoiceCsvPath: "/safe/invoices.csv",
    privateOutputDirectory: "/safe/private",
    redactedOutputDirectory: "/safe/redacted",
    now: () => now,
  };
}

function manifest(): PilotManifest {
  return {
    schemaVersion: "0.1",
    pilotId: "651cd115-6ad8-46e8-9368-6078b1620f24",
    provider: {
      id: "mainnet-provider",
      cluster: "mainnet-beta",
      endpointEnv: "PAYOPS_MAINNET_RPC_URL",
      endpointLabel: "Merchant mainnet RPC",
    },
    watches: [
      {
        id: "treasury-primary",
        tokenAccount: "Cmn8RVNLZAtyq51B31RXDrrS24DYphEftzDCX4FzPLM",
        cutoverSlot: "350000000",
        cutoverSignature: null,
        overlapSlots: "64",
      },
    ],
    invoices: { csvPath: "invoices.csv", expectedSha256: digest(csv) },
    finality: { batchSize: 64, maxPasses: 2 },
    reporting: { pseudonymizationSecretEnv: "PAYOPS_AUDIT_SECRET" },
  };
}

function artifactSet(warnings: AuditArtifactSet["warnings"]): AuditArtifactSet {
  const base = {
    contentDigest: "a".repeat(64),
    byteLength: 100,
  };
  return {
    warnings,
    privateArtifacts: [
      {
        ...base,
        audience: "private",
        format: "json",
        path: "/private/audit.json",
      },
      {
        ...base,
        audience: "private",
        format: "csv",
        path: "/private/audit.csv",
      },
    ],
    redactedArtifacts: [
      {
        ...base,
        audience: "redacted",
        format: "json",
        path: "/redacted/audit.json",
      },
      {
        ...base,
        audience: "redacted",
        format: "html",
        path: "/redacted/audit.html",
      },
    ],
  };
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
