import { createHash, randomUUID } from "node:crypto";
import { stringifyCanonical } from "@payops/core";
import postgres, { type Sql } from "postgres";
import { PILOT_STAGES, PilotError, type PilotStage } from "../domain/types.js";
import type {
  ClaimedPilotStage,
  ClaimPilotStageInput,
  CompletePilotStageInput,
  CreatePilotRunInput,
  FailPilotStageInput,
  FinishPilotRunInput,
  PilotReportInspection,
  PilotRunInspection,
  PilotRunRecord,
  PilotRunState,
  PilotStageInspection,
  PilotStageState,
  PilotStore,
  RecordPilotReportInput,
} from "./types.js";

const LEASE_MILLISECONDS = 15 * 60_000;
const MAX_STAGE_RESULT_BYTES = 64 * 1024;
const digestPattern = /^[0-9a-f]{64}$/;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const errorCodePattern = /^[a-z][a-z0-9_]{0,127}$/;

interface RunRow {
  readonly id: string;
  readonly pilot_id: string;
  readonly manifest_digest: string;
  readonly manifest_body: string;
  readonly invoice_digest: string;
  readonly state: PilotRunState;
  readonly started_at: Date;
  readonly completed_at: Date | null;
}

interface StageRow {
  readonly run_id: string;
  readonly stage: PilotStage;
  readonly ordinal: number;
  readonly state: PilotStageState;
  readonly lease_token: string | null;
  readonly lease_expires_at: Date | null;
  readonly result: Readonly<Record<string, unknown>> | null;
  readonly error_code: string | null;
  readonly started_at: Date | null;
  readonly completed_at: Date | null;
}

interface ReportRow {
  readonly audience: PilotReportInspection["audience"];
  readonly format: PilotReportInspection["format"];
  readonly content_digest: string;
  readonly byte_length: number;
  readonly created_at: Date;
}

export interface PostgresPilotStoreConfig {
  readonly databaseUrl: string;
}

export class PostgresPilotStore implements PilotStore {
  readonly #sql: Sql;

  public constructor(config: PostgresPilotStoreConfig) {
    if (config.databaseUrl.length === 0) {
      throw new PilotError(
        "invalid_configuration",
        "Pilot database configuration is invalid",
      );
    }
    this.#sql = postgres(config.databaseUrl);
  }

  public async getOrCreateRun(
    input: CreatePilotRunInput,
  ): Promise<PilotRunRecord> {
    validateCreateRunInput(input);
    try {
      return await this.#sql.begin(async (transaction) => {
        const id = randomUUID();
        await transaction`
          INSERT INTO pilot_runs (
            id, pilot_id, manifest_digest, manifest_body, invoice_digest,
            state, started_at
          ) VALUES (
            ${id}, ${input.pilotId}, ${input.manifestDigest},
            ${input.manifestBody}, ${input.invoiceDigest}, 'running',
            ${input.startedAt.toISOString()}
          )
          ON CONFLICT (pilot_id, manifest_digest) DO NOTHING
        `;
        const [row] = await transaction<RunRow[]>`
          SELECT * FROM pilot_runs
          WHERE pilot_id = ${input.pilotId}
            AND manifest_digest = ${input.manifestDigest}
          FOR UPDATE
        `;
        if (
          row === undefined ||
          row.manifest_body !== input.manifestBody ||
          row.invoice_digest !== input.invoiceDigest
        ) {
          throw conflict();
        }
        for (const [index, stage] of PILOT_STAGES.entries()) {
          await transaction`
            INSERT INTO pilot_run_stages (run_id, stage, ordinal, state)
            VALUES (${row.id}, ${stage}, ${index + 1}, 'pending')
            ON CONFLICT (run_id, stage) DO NOTHING
          `;
        }
        return mapRun(row);
      });
    } catch (error) {
      throw storageError(error);
    }
  }

  public async claimStage(
    input: ClaimPilotStageInput,
  ): Promise<ClaimedPilotStage | null> {
    assertUuid(input.runId);
    assertDate(input.now);
    try {
      return await this.#sql.begin(async (transaction) => {
        const [run] = await transaction<{ state: PilotRunState }[]>`
          SELECT state FROM pilot_runs WHERE id = ${input.runId} FOR UPDATE
        `;
        if (run === undefined || run.state !== "running") return null;
        const rows = await transaction<StageRow[]>`
          SELECT * FROM pilot_run_stages
          WHERE run_id = ${input.runId}
          ORDER BY ordinal
          FOR UPDATE
        `;
        const stage = rows.find((row) => row.state !== "succeeded");
        if (stage === undefined) return null;
        if (
          stage.state === "in_flight" &&
          stage.lease_expires_at !== null &&
          stage.lease_expires_at.getTime() > input.now.getTime()
        ) {
          return null;
        }
        const leaseToken = randomUUID();
        const leaseExpiresAt = new Date(
          input.now.getTime() + LEASE_MILLISECONDS,
        );
        const resumed = stage.state !== "pending";
        const updated = await transaction<{ run_id: string }[]>`
          UPDATE pilot_run_stages SET
            state = 'in_flight',
            lease_token = ${leaseToken},
            lease_expires_at = ${leaseExpiresAt.toISOString()},
            error_code = NULL,
            started_at = COALESCE(started_at, ${input.now.toISOString()})
          WHERE run_id = ${input.runId}
            AND stage = ${stage.stage}
            AND state <> 'succeeded'
          RETURNING run_id::text
        `;
        if (updated.length !== 1) return null;
        return {
          runId: input.runId,
          stage: stage.stage,
          ordinal: stage.ordinal,
          leaseToken,
          leaseExpiresAt,
          resumed,
        };
      });
    } catch (error) {
      throw storageError(error);
    }
  }

  public async completeStage(input: CompletePilotStageInput): Promise<boolean> {
    validateStageMutation(input);
    const serialized = serializeStageResult(input.result);
    try {
      const updated = await this.#sql<{ run_id: string }[]>`
        UPDATE pilot_run_stages SET
          state = 'succeeded',
          lease_token = NULL,
          lease_expires_at = NULL,
          result = ${serialized}::jsonb,
          error_code = NULL,
          completed_at = ${input.completedAt.toISOString()}
        WHERE run_id = ${input.runId}
          AND stage = ${input.stage}
          AND lease_token = ${input.leaseToken}
          AND state = 'in_flight'
        RETURNING run_id::text
      `;
      return updated.length === 1;
    } catch (error) {
      throw storageError(error);
    }
  }

  public async failStage(input: FailPilotStageInput): Promise<boolean> {
    validateStageMutation(input);
    if (!errorCodePattern.test(input.errorCode)) throw conflict();
    try {
      const updated = await this.#sql<{ run_id: string }[]>`
        UPDATE pilot_run_stages SET
          state = 'failed',
          lease_token = NULL,
          lease_expires_at = NULL,
          error_code = ${input.errorCode},
          completed_at = ${input.failedAt.toISOString()}
        WHERE run_id = ${input.runId}
          AND stage = ${input.stage}
          AND lease_token = ${input.leaseToken}
          AND state = 'in_flight'
        RETURNING run_id::text
      `;
      return updated.length === 1;
    } catch (error) {
      throw storageError(error);
    }
  }

  public async recordReport(input: RecordPilotReportInput): Promise<void> {
    validateReport(input);
    try {
      await this.#sql.begin(async (transaction) => {
        await transaction`
          INSERT INTO pilot_reports (
            run_id, audience, format, content_digest, byte_length, created_at
          ) VALUES (
            ${input.runId}, ${input.audience}, ${input.format},
            ${input.contentDigest}, ${input.byteLength},
            ${input.createdAt.toISOString()}
          )
          ON CONFLICT (run_id, audience, format) DO NOTHING
        `;
        const [row] = await transaction<ReportRow[]>`
          SELECT audience, format, content_digest, byte_length, created_at
          FROM pilot_reports
          WHERE run_id = ${input.runId}
            AND audience = ${input.audience}
            AND format = ${input.format}
        `;
        if (
          row === undefined ||
          row.content_digest !== input.contentDigest ||
          row.byte_length !== input.byteLength
        ) {
          throw conflict();
        }
      });
    } catch (error) {
      throw storageError(error);
    }
  }

  public async finishRun(input: FinishPilotRunInput): Promise<boolean> {
    assertUuid(input.runId);
    assertDate(input.completedAt);
    if (
      !(["complete", "incomplete", "failed"] as const).includes(input.state)
    ) {
      throw conflict();
    }
    try {
      const updated = await this.#sql<{ id: string }[]>`
        UPDATE pilot_runs SET
          state = ${input.state},
          completed_at = ${input.completedAt.toISOString()}
        WHERE id = ${input.runId} AND state = 'running'
          AND (
            ${input.state} = 'failed'
            OR (
              SELECT count(*) = ${PILOT_STAGES.length}
                AND bool_and(stage.state = 'succeeded')
              FROM pilot_run_stages AS stage
              WHERE stage.run_id = ${input.runId}
            )
          )
        RETURNING id::text
      `;
      if (updated.length === 1) return true;
      const [existing] = await this.#sql<{ state: PilotRunState }[]>`
        SELECT state FROM pilot_runs WHERE id = ${input.runId}
      `;
      return existing?.state === input.state;
    } catch (error) {
      throw storageError(error);
    }
  }

  public async getRun(runId: string): Promise<PilotRunInspection | null> {
    assertUuid(runId);
    try {
      const [run, stages, reports] = await Promise.all([
        this.#sql<RunRow[]>`SELECT * FROM pilot_runs WHERE id = ${runId}`,
        this.#sql<StageRow[]>`
          SELECT * FROM pilot_run_stages
          WHERE run_id = ${runId}
          ORDER BY ordinal
        `,
        this.#sql<ReportRow[]>`
          SELECT audience, format, content_digest, byte_length, created_at
          FROM pilot_reports
          WHERE run_id = ${runId}
          ORDER BY audience, format
        `,
      ]);
      const row = run[0];
      if (row === undefined) return null;
      return {
        ...mapRun(row),
        stages: stages.map(mapStage),
        reports: reports.map(mapReport),
      };
    } catch (error) {
      throw storageError(error);
    }
  }

  public async close(): Promise<void> {
    await this.#sql.end();
  }
}

function validateCreateRunInput(input: CreatePilotRunInput): void {
  assertUuid(input.pilotId);
  assertDigest(input.manifestDigest);
  assertDigest(input.invoiceDigest);
  assertDate(input.startedAt);
  if (Buffer.byteLength(input.manifestBody, "utf8") > 256 * 1024) {
    throw conflict();
  }
  try {
    const parsed = JSON.parse(input.manifestBody);
    const canonical = stringifyCanonical(parsed);
    const digest = createHash("sha256").update(canonical, "utf8").digest("hex");
    if (canonical !== input.manifestBody || digest !== input.manifestDigest) {
      throw conflict();
    }
  } catch {
    throw conflict();
  }
}

function validateStageMutation(
  input: CompletePilotStageInput | FailPilotStageInput,
): void {
  assertUuid(input.runId);
  assertUuid(input.leaseToken);
  if (!PILOT_STAGES.includes(input.stage)) throw conflict();
  assertDate("completedAt" in input ? input.completedAt : input.failedAt);
}

function validateReport(input: RecordPilotReportInput): void {
  assertUuid(input.runId);
  assertDigest(input.contentDigest);
  assertDate(input.createdAt);
  if (!(["private", "redacted"] as const).includes(input.audience)) {
    throw conflict();
  }
  if (!(["json", "csv", "html"] as const).includes(input.format)) {
    throw conflict();
  }
  if (!Number.isSafeInteger(input.byteLength) || input.byteLength <= 0) {
    throw conflict();
  }
}

function serializeStageResult(
  result: Readonly<Record<string, unknown>>,
): string {
  try {
    const serialized = JSON.stringify(result);
    if (
      serialized === undefined ||
      Buffer.byteLength(serialized, "utf8") > MAX_STAGE_RESULT_BYTES
    ) {
      throw conflict();
    }
    return serialized;
  } catch {
    throw conflict();
  }
}

function mapRun(row: RunRow): PilotRunRecord {
  return {
    id: row.id,
    pilotId: row.pilot_id,
    manifestDigest: row.manifest_digest,
    invoiceDigest: row.invoice_digest,
    state: row.state,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

function mapStage(row: StageRow): PilotStageInspection {
  return {
    stage: row.stage,
    ordinal: row.ordinal,
    state: row.state,
    result: row.result,
    errorCode: row.error_code,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

function mapReport(row: ReportRow): PilotReportInspection {
  return {
    audience: row.audience,
    format: row.format,
    contentDigest: row.content_digest,
    byteLength: row.byte_length,
    createdAt: row.created_at,
  };
}

function assertUuid(value: string): void {
  if (!uuidPattern.test(value)) throw conflict();
}

function assertDigest(value: string): void {
  if (!digestPattern.test(value)) throw conflict();
}

function assertDate(value: Date): void {
  try {
    if (Number.isFinite(Date.prototype.getTime.call(value))) return;
  } catch {
    // Unknown values, including hostile proxies, fail closed.
  }
  throw conflict();
}

function conflict(): PilotError {
  return new PilotError(
    "invalid_configuration",
    "Pilot storage input conflicts with persisted evidence",
  );
}

function storageError(error: unknown): PilotError {
  try {
    const descriptor =
      error !== null && typeof error === "object"
        ? Object.getOwnPropertyDescriptor(error, "code")
        : undefined;
    if (
      descriptor !== undefined &&
      "value" in descriptor &&
      descriptor.value === "invalid_configuration"
    ) {
      return conflict();
    }
  } catch {
    // Database failures are always reduced to a bounded public error.
  }
  return new PilotError(
    "database_unavailable",
    "Pilot database operation failed",
    true,
  );
}
