import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  createBackfillEngine,
  createFinalityEngine,
  type IngestionAuditStore,
  type IngestionStore,
  type ProviderRecord,
  type SolanaRpcPort,
  type WatchCoverageSummary,
} from "@payops/ingestion";
import {
  parseInvoiceCsv,
  runReconciliation,
  type OperatorReconciliationStore,
  type ReconciliationAuditStore,
  type ReconciliationAuditSummary,
} from "@payops/reconciliation";
import {
  PILOT_STAGES,
  PilotError,
  type AuditArtifact,
  type AuditArtifactSet,
  type AuditWarningCode,
  type PilotManifest,
  type PilotStage,
  type RunShadowAuditInput,
  type RunShadowAuditResult,
} from "../domain/types.js";
import type {
  ClaimedPilotStage,
  PilotRunInspection,
  PilotStore,
} from "../storage/types.js";

type ShadowAuditIngestionStore = IngestionStore & IngestionAuditStore;
type ShadowAuditReconciliationStore = OperatorReconciliationStore &
  ReconciliationAuditStore;

export interface BuildAuditArtifactsInput {
  readonly runId: string;
  readonly generatedAt: Date;
  readonly manifest: PilotManifest;
  readonly invoiceIds: readonly string[];
  readonly coverage: readonly WatchCoverageSummary[];
  readonly reconciliation: ReconciliationAuditSummary;
  readonly warnings: readonly AuditWarningCode[];
  readonly privateOutputDirectory: string;
  readonly redactedOutputDirectory: string;
}

export interface ShadowAuditDependencies {
  readonly pilotStore: PilotStore;
  readonly ingestionStore: ShadowAuditIngestionStore;
  readonly reconciliationStore: ShadowAuditReconciliationStore;
  readonly makeRpc: (provider: ProviderRecord) => SolanaRpcPort;
  readonly readInvoiceCsv: (path: string) => Promise<string>;
  readonly buildArtifacts: (
    input: BuildAuditArtifactsInput,
  ) => Promise<AuditArtifactSet>;
}

export function createShadowAuditRunner(
  dependencies: ShadowAuditDependencies,
): (input: RunShadowAuditInput) => Promise<RunShadowAuditResult> {
  return async (input) => {
    let latestArtifacts: AuditArtifactSet | null = null;
    try {
      const run = await dependencies.pilotStore.getOrCreateRun({
        pilotId: input.manifest.pilotId,
        manifestDigest: input.manifestDigest,
        manifestBody: input.manifestCanonicalJson,
        invoiceDigest: input.manifest.invoices.expectedSha256,
        startedAt: input.now(),
      });
      let inspection = await requireInspection(dependencies.pilotStore, run.id);
      const resumed =
        inspection.state !== "running" ||
        inspection.stages.some((stage) => stage.state !== "pending");
      if (inspection.state !== "running") {
        return completedResult(inspection, input, resumed);
      }

      for (let iteration = 0; iteration < PILOT_STAGES.length; iteration += 1) {
        const claim = await dependencies.pilotStore.claimStage({
          runId: run.id,
          now: input.now(),
        });
        if (claim === null) {
          inspection = await requireInspection(dependencies.pilotStore, run.id);
          if (inspection.stages.every((stage) => stage.state === "succeeded")) {
            return await finishAndReturn(
              dependencies.pilotStore,
              inspection,
              input,
              resumed,
              latestArtifacts,
            );
          }
          return {
            runId: run.id,
            state: "incomplete",
            resumed,
            warnings: ["audit_busy"],
            privateArtifacts: [],
            redactedArtifacts: [],
          };
        }

        try {
          const outcome = await runStage(
            dependencies,
            input,
            run.id,
            run.startedAt,
            claim,
          );
          if (outcome.artifacts !== undefined) {
            latestArtifacts = outcome.artifacts;
            for (const artifact of allArtifacts(outcome.artifacts)) {
              await dependencies.pilotStore.recordReport({
                runId: run.id,
                audience: artifact.audience,
                format: artifact.format,
                contentDigest: artifact.contentDigest,
                byteLength: artifact.byteLength,
                createdAt: input.now(),
              });
            }
          }
          const completed = await dependencies.pilotStore.completeStage({
            runId: run.id,
            stage: claim.stage,
            leaseToken: claim.leaseToken,
            result: outcome.result,
            completedAt: input.now(),
          });
          if (!completed) {
            throw new PilotError(
              "audit_incomplete",
              "Shadow audit stage lease was lost",
              true,
            );
          }
        } catch (error) {
          const safe = safeStageError(error);
          await dependencies.pilotStore.failStage({
            runId: run.id,
            stage: claim.stage,
            leaseToken: claim.leaseToken,
            errorCode: safe.code,
            failedAt: input.now(),
          });
          throw safe;
        }
      }

      inspection = await requireInspection(dependencies.pilotStore, run.id);
      return await finishAndReturn(
        dependencies.pilotStore,
        inspection,
        input,
        resumed,
        latestArtifacts,
      );
    } finally {
      await Promise.allSettled([
        dependencies.ingestionStore.close(),
        dependencies.reconciliationStore.close(),
        dependencies.pilotStore.close(),
      ]);
    }
  };
}

async function runStage(
  dependencies: ShadowAuditDependencies,
  input: RunShadowAuditInput,
  runId: string,
  runStartedAt: Date,
  claim: ClaimedPilotStage,
): Promise<{
  readonly result: Readonly<Record<string, unknown>>;
  readonly artifacts?: AuditArtifactSet;
}> {
  switch (claim.stage) {
    case "configure": {
      const provider = await dependencies.ingestionStore.addProvider(
        input.manifest.provider,
      );
      for (const watch of input.manifest.watches) {
        await dependencies.ingestionStore.addWatchTarget({
          id: watch.id,
          providerId: provider.id,
          cluster: provider.cluster,
          address: watch.tokenAccount,
          cutoverSlot: BigInt(watch.cutoverSlot),
          cutoverSignature: watch.cutoverSignature,
          overlapSlots: BigInt(watch.overlapSlots),
          createdAt: input.now(),
        });
      }
      return {
        result: { providers: 1, watches: input.manifest.watches.length },
      };
    }
    case "import_invoices": {
      const invoices = await loadInvoices(dependencies, input);
      const result = await dependencies.reconciliationStore.importInvoices(
        invoices,
        input.now(),
      );
      return { result: { ...result, invoices: invoices.length } };
    }
    case "sync": {
      const provider = await requireProvider(dependencies, input.manifest);
      const rpc = dependencies.makeRpc(provider);
      const engine = createBackfillEngine({
        rpc,
        store: dependencies.ingestionStore,
      });
      const reports = [];
      for (const watch of input.manifest.watches) {
        const report = await engine.syncWatchTarget({
          providerId: provider.id,
          watchTargetId: watch.id,
          now: input.now(),
        });
        if (report.result === "busy") {
          throw new PilotError(
            "audit_incomplete",
            "A watch target is currently being synchronized",
            true,
          );
        }
        reports.push(report);
      }
      return {
        result: {
          watches: reports.length,
          complete: reports.filter((report) => report.result === "complete")
            .length,
          incomplete: reports.filter((report) => report.result === "incomplete")
            .length,
          signatures: reports.reduce(
            (total, report) => total + report.signaturesStored,
            0,
          ),
          events: reports.reduce(
            (total, report) => total + report.eventsStored,
            0,
          ),
        },
      };
    }
    case "finality": {
      const provider = await requireProvider(dependencies, input.manifest);
      const engine = createFinalityEngine({
        rpc: dependencies.makeRpc(provider),
        store: dependencies.ingestionStore,
      });
      let passes = 0;
      let checked = 0;
      let finalized = 0;
      for (; passes < input.manifest.finality.maxPasses; passes += 1) {
        const report = await engine.refresh({
          providerId: provider.id,
          limit: input.manifest.finality.batchSize,
          now: input.now(),
        });
        checked += report.observationsChecked;
        finalized += report.finalized;
        if (report.observationsChecked === 0) {
          passes += 1;
          break;
        }
      }
      return { result: { passes, checked, finalized } };
    }
    case "reconcile": {
      const result = await runReconciliation(
        dependencies.reconciliationStore,
        input.now(),
      );
      return {
        result: { ...result },
      };
    }
    case "report": {
      const invoices = await loadInvoices(dependencies, input);
      const invoiceIds = invoices.map((invoice) => invoice.invoiceId);
      const watchIds = input.manifest.watches.map((watch) => watch.id);
      const [coverage, reconciliation] = await Promise.all([
        dependencies.ingestionStore.getWatchCoverageSummaries(watchIds),
        dependencies.reconciliationStore.getAuditSummary(invoiceIds, watchIds),
      ]);
      const warnings = collectWarnings(coverage, reconciliation);
      const artifacts = await dependencies.buildArtifacts({
        runId,
        generatedAt: runStartedAt,
        manifest: input.manifest,
        invoiceIds,
        coverage,
        reconciliation,
        warnings,
        privateOutputDirectory: input.privateOutputDirectory,
        redactedOutputDirectory: input.redactedOutputDirectory,
      });
      if (!sameWarnings(artifacts.warnings, warnings)) {
        throw new PilotError(
          "artifact_write_failed",
          "Audit artifacts do not match canonical warnings",
        );
      }
      return {
        result: {
          auditState: warnings.length === 0 ? "complete" : "incomplete",
          warnings,
          artifacts: allArtifacts(artifacts).length,
        },
        artifacts,
      };
    }
  }
}

async function loadInvoices(
  dependencies: ShadowAuditDependencies,
  input: RunShadowAuditInput,
) {
  const csv = await dependencies.readInvoiceCsv(input.invoiceCsvPath);
  const digest = createHash("sha256").update(csv, "utf8").digest("hex");
  if (digest !== input.manifest.invoices.expectedSha256) {
    throw new PilotError(
      "invoice_digest_mismatch",
      "Invoice CSV digest does not match the manifest",
    );
  }
  return parseInvoiceCsv(csv);
}

async function requireProvider(
  dependencies: ShadowAuditDependencies,
  manifest: PilotManifest,
): Promise<ProviderRecord> {
  const provider = await dependencies.ingestionStore.getProvider(
    manifest.provider.id,
  );
  if (provider === null) {
    throw new PilotError(
      "invalid_configuration",
      "Configured RPC provider is unavailable",
    );
  }
  return provider;
}

function collectWarnings(
  coverage: readonly WatchCoverageSummary[],
  reconciliation: ReconciliationAuditSummary,
): readonly AuditWarningCode[] {
  const warnings: AuditWarningCode[] = [];
  if (coverage.some((watch) => watch.coverage === "incomplete")) {
    warnings.push("coverage_incomplete");
  }
  if (coverage.some((watch) => watch.pendingFinality > 0)) {
    warnings.push("finality_pending");
  }
  if (coverage.some((watch) => watch.retriesOpen > 0)) {
    warnings.push("open_retries");
  }
  if (coverage.some((watch) => watch.quarantinesOpen > 0)) {
    warnings.push("open_quarantines");
  }
  if (reconciliation.unmatchedFinalizedEvents > 0) {
    warnings.push("unclassified_finalized_value");
  }
  return warnings;
}

async function requireInspection(
  store: PilotStore,
  runId: string,
): Promise<PilotRunInspection> {
  const inspection = await store.getRun(runId);
  if (inspection === null) {
    throw new PilotError(
      "database_unavailable",
      "Pilot run disappeared during execution",
      true,
    );
  }
  return inspection;
}

async function finishAndReturn(
  store: PilotStore,
  inspection: PilotRunInspection,
  input: RunShadowAuditInput,
  resumed: boolean,
  artifacts: AuditArtifactSet | null,
): Promise<RunShadowAuditResult> {
  const warnings = warningsFromInspection(inspection);
  const state = warnings.length === 0 ? "complete" : "incomplete";
  await store.finishRun({
    runId: inspection.id,
    state,
    completedAt: input.now(),
  });
  if (artifacts !== null) {
    return {
      runId: inspection.id,
      state,
      resumed,
      warnings,
      privateArtifacts: artifacts.privateArtifacts,
      redactedArtifacts: artifacts.redactedArtifacts,
    };
  }
  return completedResult({ ...inspection, state }, input, resumed);
}

function completedResult(
  inspection: PilotRunInspection,
  input: RunShadowAuditInput,
  resumed: boolean,
): RunShadowAuditResult {
  const warnings = warningsFromInspection(inspection);
  const artifacts = inspection.reports.map((report) => ({
    audience: report.audience,
    format: report.format,
    path: artifactPath(report.audience, report.format, input),
    contentDigest: report.contentDigest,
    byteLength: report.byteLength,
  }));
  return {
    runId: inspection.id,
    state: inspection.state === "complete" ? "complete" : "incomplete",
    resumed,
    warnings,
    privateArtifacts: artifacts.filter(
      (artifact) => artifact.audience === "private",
    ),
    redactedArtifacts: artifacts.filter(
      (artifact) => artifact.audience === "redacted",
    ),
  };
}

function warningsFromInspection(
  inspection: PilotRunInspection,
): readonly AuditWarningCode[] {
  const result = inspection.stages.find(
    (stage) => stage.stage === "report",
  )?.result;
  const candidate = result?.warnings;
  if (!Array.isArray(candidate)) return [];
  return candidate.filter(isAuditWarningCode);
}

function isAuditWarningCode(value: unknown): value is AuditWarningCode {
  return (
    value === "coverage_incomplete" ||
    value === "finality_pending" ||
    value === "open_retries" ||
    value === "open_quarantines" ||
    value === "unclassified_finalized_value" ||
    value === "audit_busy"
  );
}

function artifactPath(
  audience: AuditArtifact["audience"],
  format: AuditArtifact["format"],
  input: RunShadowAuditInput,
): string {
  const directory =
    audience === "private"
      ? input.privateOutputDirectory
      : input.redactedOutputDirectory;
  const name = audience === "private" ? "private-audit" : "grant-audit";
  return join(directory, `${name}.${format}`);
}

function allArtifacts(set: AuditArtifactSet): readonly AuditArtifact[] {
  return [...set.privateArtifacts, ...set.redactedArtifacts];
}

function sameWarnings(
  left: readonly AuditWarningCode[],
  right: readonly AuditWarningCode[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

class ShadowAuditStageError extends Error {
  public readonly code: string;
  public readonly retryable: boolean;

  public constructor(code: string) {
    super("Shadow audit stage failed");
    this.name = "ShadowAuditStageError";
    this.code = code;
    this.retryable = code.startsWith("rpc_") || code === "database_unavailable";
  }
}

function safeStageError(error: unknown): ShadowAuditStageError {
  let code = "database_unavailable";
  try {
    const descriptor =
      error !== null &&
      (typeof error === "object" || typeof error === "function")
        ? Object.getOwnPropertyDescriptor(error, "code")
        : undefined;
    if (
      descriptor !== undefined &&
      "value" in descriptor &&
      typeof descriptor.value === "string" &&
      /^[a-z][a-z0-9_]{0,127}$/.test(descriptor.value)
    ) {
      code = descriptor.value;
    }
  } catch {
    code = "database_unavailable";
  }
  return new ShadowAuditStageError(code);
}
