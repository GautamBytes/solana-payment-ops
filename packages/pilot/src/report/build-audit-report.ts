import { createHash } from "node:crypto";
import { join } from "node:path";
import { stringifyCanonical } from "@payops/core";
import type { ReconciliationReportRow } from "@payops/reconciliation";
import {
  PilotError,
  type AuditArtifact,
  type AuditArtifactSet,
  type AuditReportRow,
  type AuditReportV01,
} from "../domain/types.js";
import type { BuildAuditArtifactsInput } from "../orchestration/run-shadow-audit.js";
import { pseudonymize } from "./pseudonymize.js";
import { renderAuditCsv } from "./render-csv.js";
import { renderAuditHtml } from "./render-html.js";
import { writeAuditArtifact } from "./write-artifacts.js";

export interface AuditArtifactBuilderDependencies {
  readonly env: NodeJS.ProcessEnv;
  readonly getAuditRows: (
    invoiceIds: readonly string[],
    watchTargetIds: readonly string[],
  ) => Promise<readonly ReconciliationReportRow[]>;
}

export async function buildAuditArtifacts(
  input: BuildAuditArtifactsInput,
  dependencies: AuditArtifactBuilderDependencies,
): Promise<AuditArtifactSet> {
  const secret = ownSecret(
    dependencies.env,
    input.manifest.reporting.pseudonymizationSecretEnv,
  );
  const sourceRows = await dependencies.getAuditRows(
    input.invoiceIds,
    input.manifest.watches.map((watch) => watch.id),
  );
  const rows = sourceRows.map(toAuditRow).sort(compareRows);
  const privateReport = report(input, rows);
  const redactedReport = redactReport(privateReport, secret);
  const privateJson = stringifyCanonical(privateReport);
  const privateCsv = renderAuditCsv(privateReport);
  const redactedJson = stringifyCanonical(redactedReport);
  const redactedDigest = createHash("sha256")
    .update(redactedJson, "utf8")
    .digest("hex");
  const redactedHtml = renderAuditHtml(redactedReport, redactedDigest);

  const privateArtifacts = await writeAll([
    writeAuditArtifact(
      join(input.privateOutputDirectory, "private-audit.json"),
      "private",
      "json",
      privateJson,
    ),
    writeAuditArtifact(
      join(input.privateOutputDirectory, "private-audit.csv"),
      "private",
      "csv",
      privateCsv,
    ),
  ]);
  const redactedArtifacts = await writeAll([
    writeAuditArtifact(
      join(input.redactedOutputDirectory, "redacted-audit.json"),
      "redacted",
      "json",
      redactedJson,
    ),
    writeAuditArtifact(
      join(input.redactedOutputDirectory, "redacted-audit.html"),
      "redacted",
      "html",
      redactedHtml,
    ),
  ]);
  return { warnings: input.warnings, privateArtifacts, redactedArtifacts };
}

async function writeAll(
  writes: readonly Promise<AuditArtifact>[],
): Promise<readonly AuditArtifact[]> {
  const results = await Promise.allSettled(writes);
  const artifacts: AuditArtifact[] = [];
  for (const result of results) {
    if (result.status === "rejected") {
      throw new PilotError(
        "artifact_write_failed",
        "Audit artifact could not be written safely",
      );
    }
    artifacts.push(result.value);
  }
  return artifacts;
}

function report(
  input: BuildAuditArtifactsInput,
  rows: readonly AuditReportRow[],
): AuditReportV01 {
  return {
    schemaVersion: "0.1",
    runId: input.runId,
    generatedAt: input.generatedAt.toISOString(),
    coverage: input.coverage.map((value) => ({ ...value })),
    totals: {
      invoices: input.reconciliation.invoiceCount,
      finalizedEvents: input.coverage.reduce(
        (total, watch) => total + watch.finalized,
        0,
      ),
      exactMatches: input.reconciliation.allocationCount,
      exceptions: input.reconciliation.exceptionCount,
      unapplied:
        rows.filter((row) => row.status === "unapplied").length +
        input.reconciliation.unmatchedFinalizedEvents,
    },
    exceptionsByCode: Object.fromEntries(
      Object.entries(input.reconciliation.exceptionsByCode).sort(
        ([left], [right]) => left.localeCompare(right),
      ),
    ),
    warnings: [...input.warnings],
    rows,
  };
}

function redactReport(report: AuditReportV01, secret: string): AuditReportV01 {
  return {
    ...report,
    coverage: report.coverage.map((watch) => ({
      ...watch,
      watchTargetId: pseudonymize("watch", watch.watchTargetId, secret),
    })),
    rows: report.rows.map((row) => ({
      ...row,
      invoiceId:
        row.invoiceId === null
          ? null
          : pseudonymize("invoice", row.invoiceId, secret),
      customerId:
        row.customerId === null
          ? null
          : pseudonymize("customer", row.customerId, secret),
      eventId:
        row.eventId === null
          ? null
          : pseudonymize("event", row.eventId, secret),
    })),
  };
}

function toAuditRow(row: ReconciliationReportRow): AuditReportRow {
  return {
    invoiceId: row.invoiceId.length === 0 ? null : row.invoiceId,
    customerId: row.customerId.length === 0 ? null : row.customerId,
    status: row.status,
    expectedMint: row.expectedMint,
    amountBaseUnits: row.amountBaseUnits,
    eventId: row.eventId,
    ruleCode: row.ruleCode,
  };
}

function compareRows(left: AuditReportRow, right: AuditReportRow): number {
  return `${left.invoiceId ?? ""}\0${left.eventId ?? ""}`.localeCompare(
    `${right.invoiceId ?? ""}\0${right.eventId ?? ""}`,
  );
}

function ownSecret(env: NodeJS.ProcessEnv, name: string): string {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(env, name);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      typeof descriptor.value !== "string" ||
      Buffer.byteLength(descriptor.value, "utf8") < 32 ||
      Buffer.byteLength(descriptor.value, "utf8") > 1024
    ) {
      throw invalidSecret();
    }
    return descriptor.value;
  } catch (error) {
    throw invalidSecret();
  }
}

function invalidSecret(): PilotError {
  return new PilotError(
    "invalid_configuration",
    "Pseudonymization secret configuration is invalid",
  );
}
