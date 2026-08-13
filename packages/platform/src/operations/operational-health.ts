import type {
  OrganizationDatabase,
  OrganizationTransaction,
} from "../db/organization-transaction.js";
import type { RpcProviderConfigurationIdentity } from "../config/rpc-provider.js";
import type { IdempotencyResponseCommitter } from "../idempotency/idempotency-store.js";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const scopeKeyPattern = /^[0-9a-f]{64}$/;
const actorPattern = /^[\x21-\x7e]{1,128}$/;

export const OPERATIONAL_MEASUREMENT_KINDS = [
  "rpc_consensus_checks",
  "rpc_consensus_disagreements",
  "ingestion_gap_seconds",
  "worker_heartbeat_age_seconds",
  "ledger_mismatches",
  "webhook_dead_letters",
  "webhook_delivery_duration_milliseconds",
] as const;

export const OPERATIONAL_INCIDENT_KINDS = [
  "rpc_disagreement",
  "ingestion_gap",
  "worker_stale",
  "ledger_mismatch",
  "webhook_dead_letter",
] as const;

export type OperationalMeasurementKind =
  (typeof OPERATIONAL_MEASUREMENT_KINDS)[number];
export type OperationalIncidentKind =
  (typeof OPERATIONAL_INCIDENT_KINDS)[number];
export type OperationalIncidentSeverity = "warning" | "critical";
export type OperationalIncidentState = "open" | "acknowledged" | "resolved";
export type OperationalActorKind = "system" | "session" | "api_key";
export type OperationalResolutionCode =
  "condition_cleared" | "operator_resolved";

export interface OperationalMeasurement {
  readonly kind: OperationalMeasurementKind;
  readonly unit: "count" | "seconds" | "milliseconds";
  readonly windowSeconds: 300;
  readonly bucketStart: string;
  readonly value: number;
  readonly sampleCount: number;
  readonly generatedAt: string;
}

export interface OperationalIncident {
  readonly id: string;
  readonly kind: OperationalIncidentKind;
  readonly severity: OperationalIncidentSeverity;
  readonly scopeKey: string;
  readonly state: OperationalIncidentState;
  readonly version: number;
  readonly firstObservedAt: string;
  readonly lastObservedAt: string;
  readonly occurrenceCount: number;
  readonly acknowledgedAt: string | null;
  readonly acknowledgedActorKind: OperationalActorKind | null;
  readonly resolvedAt: string | null;
  readonly resolvedActorKind: OperationalActorKind | null;
  readonly resolutionCode: OperationalResolutionCode | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface OperationalIncidentEvent {
  readonly id: string;
  readonly incidentId: string;
  readonly incidentVersion: number;
  readonly action: "opened" | "reobserved" | "acknowledged" | "resolved";
  readonly fromState: "open" | "acknowledged" | null;
  readonly toState: OperationalIncidentState;
  readonly occurrenceCount: number;
  readonly actorKind: OperationalActorKind;
  readonly occurredAt: string;
  readonly createdAt: string;
}

export interface OperationalIncidentCursor {
  readonly lastObservedAt: string;
  readonly id: string;
}

export interface OperationalIncidentHistoryCursor {
  readonly incidentVersion: number;
  readonly id: string;
}

export interface OperationalPage<T, Cursor> {
  readonly items: readonly T[];
  readonly nextCursor: Cursor | null;
}

export interface OperationalHealthSnapshot {
  readonly measurements: readonly OperationalMeasurement[];
  readonly openWarningCount: number;
  readonly openCriticalCount: number;
  readonly generatedAt: string;
}

export interface OperationalIncidentIdempotency {
  readonly committer: IdempotencyResponseCommitter;
  readonly status: number;
  readonly responseBody: (incident: OperationalIncident) => unknown;
  readonly errorResponse?: (
    code: "incident_not_found" | "incident_version_conflict",
  ) => { readonly status: number; readonly body: unknown };
}

export class OperationalHealthError extends Error {
  public constructor(
    readonly code: string,
    cause?: unknown,
    readonly idempotencyCompleted: boolean = false,
  ) {
    super(
      "Operational health operation failed",
      cause === undefined ? {} : { cause },
    );
    this.name = "OperationalHealthError";
  }
}

export class OperationalHealthStore {
  readonly #database: OrganizationDatabase;

  public constructor(database: OrganizationDatabase) {
    this.#database = database;
  }

  public async recordMeasurement(input: {
    readonly organizationId: string;
    readonly actorId: string;
    readonly kind: OperationalMeasurementKind;
    readonly value: number;
    readonly generatedAt: Date;
  }): Promise<void> {
    validateContext(input.organizationId, input.actorId);
    validateMeasurement(input.kind, input.value, input.generatedAt);
    await this.#run(input, async (sql) => {
      await sql`
        SELECT payops_record_operational_measurement(
          ${input.organizationId}::uuid, ${input.kind}, ${input.value}::numeric,
          ${input.generatedAt.toISOString()}::timestamptz
        )
      `;
    });
  }

  public async getSnapshot(input: {
    readonly organizationId: string;
    readonly actorId: string;
  }): Promise<OperationalHealthSnapshot> {
    validateContext(input.organizationId, input.actorId);
    return this.#run(input, async (sql) => {
      const measurements = await sql<MeasurementRow[]>`
        SELECT DISTINCT ON (kind) kind, unit, window_seconds, bucket_start,
          value::text, sample_count, generated_at
        FROM operational_measurements
        WHERE organization_id = ${input.organizationId}::uuid
        ORDER BY kind, bucket_start DESC
      `;
      const [counts] = await sql<IncidentCountRow[]>`
        SELECT
          count(*) FILTER (WHERE severity = 'warning')::integer
            AS open_warning_count,
          count(*) FILTER (WHERE severity = 'critical')::integer
            AS open_critical_count,
          clock_timestamp() AS generated_at
        FROM operational_incidents
        WHERE organization_id = ${input.organizationId}::uuid
          AND state IN ('open', 'acknowledged')
      `;
      if (counts === undefined)
        throw new OperationalHealthError("operational_health_unavailable");
      return {
        measurements: measurements.map(toMeasurement),
        openWarningCount: counts.open_warning_count,
        openCriticalCount: counts.open_critical_count,
        generatedAt: counts.generated_at.toISOString(),
      };
    });
  }

  public async observeIncident(input: {
    readonly organizationId: string;
    readonly actorId: string;
    readonly actorKind: OperationalActorKind;
    readonly kind: OperationalIncidentKind;
    readonly severity: OperationalIncidentSeverity;
    readonly scopeKey: string;
    readonly observedAt: Date;
  }): Promise<OperationalIncident> {
    validateContext(input.organizationId, input.actorId);
    validateIncidentObservation(input);
    return this.#run(input, async (sql) => {
      const [result] = await sql<{ incident_id: string }[]>`
        SELECT payops_observe_operational_incident(
          ${input.organizationId}::uuid, ${input.actorKind}, ${input.kind},
          ${input.severity}, ${input.scopeKey},
          ${input.observedAt.toISOString()}::timestamptz
        )::text AS incident_id
      `;
      if (result === undefined)
        throw new OperationalHealthError("operational_health_unavailable");
      return selectIncident(sql, input.organizationId, result.incident_id);
    });
  }

  public async acknowledgeIncident(input: {
    readonly organizationId: string;
    readonly actorId: string;
    readonly actorKind: OperationalActorKind;
    readonly incidentId: string;
    readonly expectedVersion: number;
    readonly acknowledgedAt: Date;
    readonly idempotency?: OperationalIncidentIdempotency;
  }): Promise<OperationalIncident> {
    validateTransition(input, input.acknowledgedAt);
    const outcome = await this.#run<IncidentTransitionOutcome>(
      input,
      async (sql) => {
        const blocked = await transitionError(
          sql,
          input.organizationId,
          input.incidentId,
          input.expectedVersion,
        );
        if (blocked !== null) {
          return completeTransitionError(sql, input.idempotency, blocked);
        }
        await sql`
        SELECT payops_acknowledge_operational_incident(
          ${input.organizationId}::uuid, ${input.incidentId}::uuid,
          ${input.expectedVersion}::integer, ${input.actorKind},
          ${input.acknowledgedAt.toISOString()}::timestamptz
        )
      `;
        const incident = await selectIncident(
          sql,
          input.organizationId,
          input.incidentId,
        );
        if (input.idempotency !== undefined) {
          await input.idempotency.committer.complete(
            sql,
            input.idempotency.status,
            input.idempotency.responseBody(incident),
          );
        }
        return { incident };
      },
    );
    if ("error" in outcome) {
      throw new OperationalHealthError(
        outcome.error,
        undefined,
        outcome.idempotencyCompleted,
      );
    }
    return outcome.incident;
  }

  public async resolveIncident(input: {
    readonly organizationId: string;
    readonly actorId: string;
    readonly actorKind: OperationalActorKind;
    readonly incidentId: string;
    readonly expectedVersion: number;
    readonly resolutionCode: OperationalResolutionCode;
    readonly resolvedAt: Date;
    readonly idempotency?: OperationalIncidentIdempotency;
  }): Promise<OperationalIncident> {
    validateTransition(input, input.resolvedAt);
    if (!isResolutionCode(input.resolutionCode)) invalidInput();
    const outcome = await this.#run<IncidentTransitionOutcome>(
      input,
      async (sql) => {
        const blocked = await transitionError(
          sql,
          input.organizationId,
          input.incidentId,
          input.expectedVersion,
        );
        if (blocked !== null) {
          return completeTransitionError(sql, input.idempotency, blocked);
        }
        await sql`
        SELECT payops_resolve_operational_incident(
          ${input.organizationId}::uuid, ${input.incidentId}::uuid,
          ${input.expectedVersion}::integer, ${input.resolutionCode},
          ${input.actorKind}, ${input.resolvedAt.toISOString()}::timestamptz
        )
      `;
        const incident = await selectIncident(
          sql,
          input.organizationId,
          input.incidentId,
        );
        if (input.idempotency !== undefined) {
          await input.idempotency.committer.complete(
            sql,
            input.idempotency.status,
            input.idempotency.responseBody(incident),
          );
        }
        return { incident };
      },
    );
    if ("error" in outcome) {
      throw new OperationalHealthError(
        outcome.error,
        undefined,
        outcome.idempotencyCompleted,
      );
    }
    return outcome.incident;
  }

  public async listIncidents(input: {
    readonly organizationId: string;
    readonly actorId: string;
    readonly state?: OperationalIncidentState;
    readonly kind?: OperationalIncidentKind;
    readonly limit?: number;
    readonly cursor?: OperationalIncidentCursor;
  }): Promise<OperationalPage<OperationalIncident, OperationalIncidentCursor>> {
    validateContext(input.organizationId, input.actorId);
    const limit = validatePage(input.limit, input.cursor, "incident");
    if (input.state !== undefined && !isIncidentState(input.state))
      invalidInput();
    if (input.kind !== undefined && !isIncidentKind(input.kind)) invalidInput();
    return this.#run(input, async (sql) => {
      const rows = await sql<IncidentRow[]>`
        SELECT id::text, kind, severity, scope_key, state, version,
          first_observed_at, last_observed_at, occurrence_count,
          acknowledged_at, acknowledged_actor_kind, resolved_at,
          resolved_actor_kind, resolution_code, created_at, updated_at
        FROM operational_incidents
        WHERE organization_id = ${input.organizationId}::uuid
          AND (${input.state ?? null}::text IS NULL OR state = ${input.state ?? null})
          AND (${input.kind ?? null}::text IS NULL OR kind = ${input.kind ?? null})
          AND (
            ${input.cursor?.lastObservedAt ?? null}::timestamptz IS NULL
            OR (last_observed_at, id) < (
              ${input.cursor?.lastObservedAt ?? null}::timestamptz,
              ${input.cursor?.id ?? null}::uuid
            )
          )
        ORDER BY last_observed_at DESC, id DESC
        LIMIT ${limit + 1}
      `;
      const pageRows = rows.slice(0, limit);
      const items = pageRows.map(toIncident);
      const tail = rows.length > limit ? items.at(-1) : undefined;
      return {
        items,
        nextCursor:
          tail === undefined
            ? null
            : { lastObservedAt: tail.lastObservedAt, id: tail.id },
      };
    });
  }

  public async listIncidentHistory(input: {
    readonly organizationId: string;
    readonly actorId: string;
    readonly incidentId: string;
    readonly limit?: number;
    readonly cursor?: OperationalIncidentHistoryCursor;
  }): Promise<
    OperationalPage<OperationalIncidentEvent, OperationalIncidentHistoryCursor>
  > {
    validateContext(input.organizationId, input.actorId);
    if (!uuidPattern.test(input.incidentId)) invalidInput();
    const limit = validatePage(input.limit, input.cursor, "history");
    return this.#run(input, async (sql) => {
      const [incident] = await sql<{ present: boolean }[]>`
        SELECT true AS present FROM operational_incidents
        WHERE organization_id = ${input.organizationId}::uuid
          AND id = ${input.incidentId}::uuid
      `;
      if (incident === undefined)
        throw new OperationalHealthError("incident_not_found");
      const rows = await sql<IncidentEventRow[]>`
        SELECT id::text, incident_id::text, incident_version, action,
          from_state, to_state, occurrence_count, actor_kind,
          occurred_at, created_at
        FROM operational_incident_events
        WHERE organization_id = ${input.organizationId}::uuid
          AND incident_id = ${input.incidentId}::uuid
          AND (
            ${input.cursor?.incidentVersion ?? null}::integer IS NULL
            OR (incident_version, id) < (
              ${input.cursor?.incidentVersion ?? null}::integer,
              ${input.cursor?.id ?? null}::uuid
            )
          )
        ORDER BY incident_version DESC, id DESC
        LIMIT ${limit + 1}
      `;
      const pageRows = rows.slice(0, limit);
      const items = pageRows.map(toIncidentEvent);
      const tail = rows.length > limit ? items.at(-1) : undefined;
      return {
        items,
        nextCursor:
          tail === undefined
            ? null
            : { incidentVersion: tail.incidentVersion, id: tail.id },
      };
    });
  }

  public async enqueueScheduledSignals(input: {
    readonly organizationId: string;
    readonly actorId: string;
    readonly observedAt: Date;
    readonly rpc: RpcProviderConfigurationIdentity;
  }): Promise<number> {
    validateContext(input.organizationId, input.actorId);
    validateDate(input.observedAt);
    validateRpcIdentity(input.rpc);
    return this.#run(input, async (sql) => {
      const [result] = await sql<{ enqueued: number }[]>`
        SELECT payops_enqueue_scheduled_operational_health_signals(
          ${input.organizationId}::uuid,
          ${input.observedAt.toISOString()}::timestamptz,
          ${input.rpc.mode}, ${input.rpc.cluster},
          ${input.rpc.primaryProviderId},
          ${input.rpc.primaryEndpointEnvironment},
          ${input.rpc.primaryEndpointDigest},
          ${input.rpc.secondaryProviderId},
          ${input.rpc.secondaryEndpointEnvironment},
          ${input.rpc.secondaryEndpointDigest}
        ) AS enqueued
      `;
      return result?.enqueued ?? 0;
    });
  }

  public async drainSignals(input: {
    readonly organizationId: string;
    readonly actorId: string;
    readonly processedAt: Date;
    readonly limit?: number;
  }): Promise<number> {
    validateContext(input.organizationId, input.actorId);
    validateDate(input.processedAt);
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      invalidInput();
    return this.#run(input, async (sql) => {
      const [result] = await sql<{ processed: number }[]>`
        SELECT payops_process_operational_health_signals(
          ${input.organizationId}::uuid, ${limit}::integer,
          ${input.processedAt.toISOString()}::timestamptz
        ) AS processed
      `;
      return result?.processed ?? 0;
    });
  }

  async #run<T>(
    context: { readonly organizationId: string; readonly actorId: string },
    operation: Parameters<OrganizationDatabase["transaction"]>[1],
  ): Promise<T> {
    try {
      return (await this.#database.transaction(context, operation)) as T;
    } catch (error) {
      if (error instanceof OperationalHealthError) throw error;
      const code = postgresErrorCode(error);
      if (code === "P0002")
        throw new OperationalHealthError("incident_not_found", error);
      if (code === "40001")
        throw new OperationalHealthError("incident_version_conflict", error);
      if (code === "22023")
        throw new OperationalHealthError(
          "invalid_operational_health_input",
          error,
        );
      throw new OperationalHealthError("operational_health_unavailable", error);
    }
  }
}

function validateRpcIdentity(value: RpcProviderConfigurationIdentity): void {
  const providerPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
  const environmentPattern = /^[A-Z][A-Z0-9_]{0,127}$/;
  const digestPattern = /^[0-9a-f]{64}$/;
  if (
    value === null ||
    typeof value !== "object" ||
    value.mode !== "dual_provider" ||
    value.cluster !== "mainnet-beta" ||
    !providerPattern.test(value.primaryProviderId) ||
    !environmentPattern.test(value.primaryEndpointEnvironment) ||
    !digestPattern.test(value.primaryEndpointDigest) ||
    value.secondaryProviderId === null ||
    !providerPattern.test(value.secondaryProviderId) ||
    value.secondaryEndpointEnvironment === null ||
    !environmentPattern.test(value.secondaryEndpointEnvironment) ||
    value.secondaryEndpointDigest === null ||
    !digestPattern.test(value.secondaryEndpointDigest) ||
    value.primaryProviderId === value.secondaryProviderId ||
    value.primaryEndpointDigest === value.secondaryEndpointDigest
  ) {
    invalidInput();
  }
}

interface MeasurementRow {
  readonly kind: OperationalMeasurementKind;
  readonly unit: "count" | "seconds" | "milliseconds";
  readonly window_seconds: 300;
  readonly bucket_start: Date;
  readonly value: string;
  readonly sample_count: number;
  readonly generated_at: Date;
}

interface IncidentCountRow {
  readonly open_warning_count: number;
  readonly open_critical_count: number;
  readonly generated_at: Date;
}

interface IncidentRow {
  readonly id: string;
  readonly kind: OperationalIncidentKind;
  readonly severity: OperationalIncidentSeverity;
  readonly scope_key: string;
  readonly state: OperationalIncidentState;
  readonly version: number;
  readonly first_observed_at: Date;
  readonly last_observed_at: Date;
  readonly occurrence_count: number;
  readonly acknowledged_at: Date | null;
  readonly acknowledged_actor_kind: OperationalActorKind | null;
  readonly resolved_at: Date | null;
  readonly resolved_actor_kind: OperationalActorKind | null;
  readonly resolution_code: OperationalResolutionCode | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface IncidentEventRow {
  readonly id: string;
  readonly incident_id: string;
  readonly incident_version: number;
  readonly action: "opened" | "reobserved" | "acknowledged" | "resolved";
  readonly from_state: "open" | "acknowledged" | null;
  readonly to_state: OperationalIncidentState;
  readonly occurrence_count: number;
  readonly actor_kind: OperationalActorKind;
  readonly occurred_at: Date;
  readonly created_at: Date;
}

type IncidentTransitionOutcome =
  | { readonly incident: OperationalIncident }
  | {
      readonly error: "incident_not_found" | "incident_version_conflict";
      readonly idempotencyCompleted: boolean;
    };

async function transitionError(
  sql: OrganizationTransaction,
  organizationId: string,
  incidentId: string,
  expectedVersion: number,
): Promise<"incident_not_found" | "incident_version_conflict" | null> {
  await sql`
    SELECT pg_advisory_xact_lock(hashtextextended(
      ${`${organizationId}:operational-health-authority`}, 0
    ))
  `;
  const [incident] = await sql<{ version: number }[]>`
    SELECT version FROM operational_incidents
    WHERE organization_id = ${organizationId}::uuid
      AND id = ${incidentId}::uuid
  `;
  if (incident === undefined) return "incident_not_found";
  return incident.version === expectedVersion
    ? null
    : "incident_version_conflict";
}

async function completeTransitionError(
  sql: OrganizationTransaction,
  idempotency: OperationalIncidentIdempotency | undefined,
  error: "incident_not_found" | "incident_version_conflict",
): Promise<{
  readonly error: "incident_not_found" | "incident_version_conflict";
  readonly idempotencyCompleted: boolean;
}> {
  if (idempotency?.errorResponse === undefined) {
    return { error, idempotencyCompleted: false };
  }
  const response = idempotency.errorResponse(error);
  await idempotency.committer.complete(sql, response.status, response.body);
  return { error, idempotencyCompleted: true };
}

async function selectIncident(
  sql: Parameters<OrganizationDatabase["transaction"]>[1] extends (
    transaction: infer Transaction,
  ) => unknown
    ? Transaction
    : never,
  organizationId: string,
  incidentId: string,
): Promise<OperationalIncident> {
  const [row] = await sql<IncidentRow[]>`
    SELECT id::text, kind, severity, scope_key, state, version,
      first_observed_at, last_observed_at, occurrence_count,
      acknowledged_at, acknowledged_actor_kind, resolved_at,
      resolved_actor_kind, resolution_code, created_at, updated_at
    FROM operational_incidents
    WHERE organization_id = ${organizationId}::uuid AND id = ${incidentId}::uuid
  `;
  if (row === undefined) throw new OperationalHealthError("incident_not_found");
  return toIncident(row);
}

function toMeasurement(row: MeasurementRow): OperationalMeasurement {
  return {
    kind: row.kind,
    unit: row.unit,
    windowSeconds: row.window_seconds,
    bucketStart: row.bucket_start.toISOString(),
    value: Number(row.value),
    sampleCount: row.sample_count,
    generatedAt: row.generated_at.toISOString(),
  };
}

function toIncident(row: IncidentRow): OperationalIncident {
  return {
    id: row.id,
    kind: row.kind,
    severity: row.severity,
    scopeKey: row.scope_key,
    state: row.state,
    version: row.version,
    firstObservedAt: row.first_observed_at.toISOString(),
    lastObservedAt: row.last_observed_at.toISOString(),
    occurrenceCount: row.occurrence_count,
    acknowledgedAt: row.acknowledged_at?.toISOString() ?? null,
    acknowledgedActorKind: row.acknowledged_actor_kind,
    resolvedAt: row.resolved_at?.toISOString() ?? null,
    resolvedActorKind: row.resolved_actor_kind,
    resolutionCode: row.resolution_code,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toIncidentEvent(row: IncidentEventRow): OperationalIncidentEvent {
  return {
    id: row.id,
    incidentId: row.incident_id,
    incidentVersion: row.incident_version,
    action: row.action,
    fromState: row.from_state,
    toState: row.to_state,
    occurrenceCount: row.occurrence_count,
    actorKind: row.actor_kind,
    occurredAt: row.occurred_at.toISOString(),
    createdAt: row.created_at.toISOString(),
  };
}

function validateContext(organizationId: string, actorId: string): void {
  if (!uuidPattern.test(organizationId) || !actorPattern.test(actorId)) {
    invalidInput();
  }
}

function validateMeasurement(
  kind: string,
  value: number,
  generatedAt: Date,
): void {
  validateDate(generatedAt);
  if (
    !isMeasurementKind(kind) ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 99_999_999_999_999 ||
    (isCountMeasurement(kind) && !Number.isSafeInteger(value))
  ) {
    invalidInput();
  }
}

function validateIncidentObservation(input: {
  readonly actorKind: string;
  readonly kind: string;
  readonly severity: string;
  readonly scopeKey: string;
  readonly observedAt: Date;
}): void {
  validateDate(input.observedAt);
  if (
    !isActorKind(input.actorKind) ||
    !isIncidentKind(input.kind) ||
    !["warning", "critical"].includes(input.severity) ||
    !scopeKeyPattern.test(input.scopeKey)
  ) {
    invalidInput();
  }
}

function validateTransition(
  input: {
    readonly organizationId: string;
    readonly actorId: string;
    readonly actorKind: string;
    readonly incidentId: string;
    readonly expectedVersion: number;
  },
  at: Date,
): void {
  validateContext(input.organizationId, input.actorId);
  validateDate(at);
  if (
    !isActorKind(input.actorKind) ||
    !uuidPattern.test(input.incidentId) ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 1
  ) {
    invalidInput();
  }
}

function validatePage(
  limitInput: number | undefined,
  cursor:
    OperationalIncidentCursor | OperationalIncidentHistoryCursor | undefined,
  kind: "incident" | "history",
): number {
  const limit = limitInput ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) invalidInput();
  if (cursor === undefined) return limit;
  if (cursor === null || typeof cursor !== "object") invalidInput();
  if (!uuidPattern.test(cursor.id)) invalidInput();
  if (kind === "incident") {
    const incidentCursor = cursor as OperationalIncidentCursor;
    if (!isIsoDate(incidentCursor.lastObservedAt)) invalidInput();
  } else {
    const historyCursor = cursor as OperationalIncidentHistoryCursor;
    if (
      !Number.isSafeInteger(historyCursor.incidentVersion) ||
      historyCursor.incidentVersion < 1
    ) {
      invalidInput();
    }
  }
  return limit;
}

function validateDate(value: Date): void {
  try {
    if (!Number.isFinite(Date.prototype.getTime.call(value))) invalidInput();
  } catch {
    invalidInput();
  }
}

function isIsoDate(value: string): boolean {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function isMeasurementKind(value: string): value is OperationalMeasurementKind {
  return (OPERATIONAL_MEASUREMENT_KINDS as readonly string[]).includes(value);
}

function isCountMeasurement(kind: OperationalMeasurementKind): boolean {
  return [
    "rpc_consensus_checks",
    "rpc_consensus_disagreements",
    "ledger_mismatches",
    "webhook_dead_letters",
  ].includes(kind);
}

function isIncidentKind(value: string): value is OperationalIncidentKind {
  return (OPERATIONAL_INCIDENT_KINDS as readonly string[]).includes(value);
}

function isIncidentState(value: string): value is OperationalIncidentState {
  return ["open", "acknowledged", "resolved"].includes(value);
}

function isActorKind(value: string): value is OperationalActorKind {
  return ["system", "session", "api_key"].includes(value);
}

function isResolutionCode(value: string): value is OperationalResolutionCode {
  return ["condition_cleared", "operator_resolved"].includes(value);
}

function invalidInput(): never {
  throw new OperationalHealthError("invalid_operational_health_input");
}

function postgresErrorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(error, "code");
  return descriptor !== undefined &&
    "value" in descriptor &&
    typeof descriptor.value === "string"
    ? descriptor.value
    : undefined;
}
