import { randomUUID } from "node:crypto";

export type ExceptionReviewState =
  "open" | "assigned" | "investigating" | "escalated" | "resolved" | "ignored";

export interface PaymentException {
  readonly id: string;
  readonly invoiceId: string | null;
  readonly attemptId: string;
  readonly eventId: string;
  readonly signature: string;
  readonly amountBaseUnits: string;
  readonly assetSymbol: "USDC" | "USDT" | null;
  readonly mint: string;
  readonly decimals: number;
  readonly ruleCode: string;
  readonly ruleVersion: string;
  readonly reviewState: ExceptionReviewState;
  readonly assignedTo: string | null;
  readonly resolutionCode: string | null;
  readonly resolutionNote: string | null;
  readonly resolvedBy: string | null;
  readonly resolvedAt: string | null;
  readonly version: number;
  readonly createdAt: string;
}

export interface ExceptionPage {
  readonly data: readonly PaymentException[];
  readonly nextCursor: string | null;
}

export type PromotionBlocker =
  | "watch_coverage_incomplete"
  | "worker_heartbeat_stale"
  | "production_rpc_roles_incomplete"
  | "open_critical_incident";

export interface ProductionControlView {
  readonly status: {
    readonly activationMode: "shadow" | "live";
    readonly version: number;
    readonly promotedAt: string | null;
    readonly createdAt: string;
    readonly updatedAt: string;
  };
  readonly evaluation: {
    readonly eligible: boolean;
    readonly blockers: readonly PromotionBlocker[];
    readonly prerequisites: {
      readonly completeWatchCoverage: boolean;
      readonly freshWorkerHeartbeat: boolean;
      readonly twoActiveProductionRpcRoles: boolean;
      readonly noOpenCriticalIncident: boolean;
    };
  };
  readonly capabilities: {
    readonly canManageIncidents: boolean;
    readonly canPromoteProduction: boolean;
  };
}

export type OperationalMeasurementKind =
  | "rpc_consensus_checks"
  | "rpc_consensus_disagreements"
  | "ingestion_gap_seconds"
  | "worker_heartbeat_age_seconds"
  | "ledger_mismatches"
  | "webhook_dead_letters"
  | "webhook_delivery_duration_milliseconds";

export interface OperationalHealthSnapshot {
  readonly measurements: readonly {
    readonly kind: OperationalMeasurementKind;
    readonly unit: "count" | "seconds" | "milliseconds";
    readonly windowSeconds: 300;
    readonly bucketStart: string;
    readonly value: number;
    readonly sampleCount: number;
    readonly generatedAt: string;
  }[];
  readonly openWarningCount: number;
  readonly openCriticalCount: number;
  readonly generatedAt: string;
}

export type OperationalIncidentKind =
  | "rpc_disagreement"
  | "ingestion_gap"
  | "worker_stale"
  | "ledger_mismatch"
  | "webhook_dead_letter";
export type OperationalIncidentState = "open" | "acknowledged" | "resolved";

export interface OperationalIncident {
  readonly id: string;
  readonly kind: OperationalIncidentKind;
  readonly severity: "warning" | "critical";
  readonly state: OperationalIncidentState;
  readonly version: number;
  readonly firstObservedAt: string;
  readonly lastObservedAt: string;
  readonly occurrenceCount: number;
  readonly acknowledgedAt: string | null;
  readonly acknowledgedActorKind: "system" | "session" | "api_key" | null;
  readonly resolvedAt: string | null;
  readonly resolvedActorKind: "system" | "session" | "api_key" | null;
  readonly resolutionCode: "condition_cleared" | "operator_resolved" | null;
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
  readonly actorKind: "system" | "session" | "api_key";
  readonly occurredAt: string;
  readonly createdAt: string;
}

export interface OperationalIncidentPage {
  readonly data: readonly OperationalIncident[];
  readonly nextCursor: string | null;
}

export interface OperationalIncidentHistoryPage {
  readonly data: readonly OperationalIncidentEvent[];
  readonly nextCursor: string | null;
}

export class OperationsApiError extends Error {
  public readonly code: string;

  public constructor(code: string) {
    super("PayOps operation failed");
    this.name = "OperationsApiError";
    this.code = code;
  }
}

export type AccountingExportFormat =
  | "payments_csv"
  | "invoices_csv"
  | "allocations_csv"
  | "journals_csv"
  | "quickbooks_csv";

const MAX_JSON_BYTES = 1_048_576;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export async function listPaymentExceptions(
  cookie: string,
  filters: {
    readonly limit?: number;
    readonly state?: ExceptionReviewState;
    readonly cursor?: string;
  } = {},
): Promise<ExceptionPage> {
  const limit = filters.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new Error("invalid_exception_filter");
  const query = new URLSearchParams({ limit: String(limit) });
  if (filters.state !== undefined) query.set("state", filters.state);
  if (filters.cursor !== undefined) {
    if (filters.cursor.length < 16 || filters.cursor.length > 1024)
      throw new Error("invalid_exception_filter");
    query.set("cursor", filters.cursor);
  }
  const value = await apiJson("GET", `/v1/exceptions?${query}`, cookie);
  const record = object(value);
  if (!Array.isArray(record.data) || record.data.length > 100)
    throw new Error("operations_unavailable");
  if (
    record.nextCursor !== null &&
    (typeof record.nextCursor !== "string" || record.nextCursor.length > 1024)
  )
    throw new Error("operations_unavailable");
  return {
    data: record.data.map(parseException),
    nextCursor: record.nextCursor as string | null,
  };
}

export async function getProductionControl(
  cookie: string,
): Promise<ProductionControlView> {
  return parseProductionControl(
    await apiJson("GET", "/v1/operations/production-control", cookie),
  );
}

export async function getOperationalHealth(
  cookie: string,
): Promise<OperationalHealthSnapshot> {
  return parseOperationalHealth(
    await apiJson("GET", "/v1/operations/health", cookie),
  );
}

export async function listOperationalIncidents(
  cookie: string,
  filters: {
    readonly limit?: number;
    readonly state?: OperationalIncidentState;
    readonly kind?: OperationalIncidentKind;
    readonly cursor?: string;
  } = {},
): Promise<OperationalIncidentPage> {
  const query = operationalQuery(filters);
  const record = object(
    await apiJson("GET", `/v1/operations/incidents?${query}`, cookie),
  );
  return {
    data: parsePageData(record.data, parseOperationalIncident),
    nextCursor: parseNextCursor(record.nextCursor),
  };
}

export async function getOperationalIncidentHistory(
  cookie: string,
  incidentId: string,
  filters: { readonly limit?: number; readonly cursor?: string } = {},
): Promise<OperationalIncidentHistoryPage> {
  const query = operationalQuery(filters);
  const record = object(
    await apiJson(
      "GET",
      `/v1/operations/incidents/${pathId(incidentId)}/history?${query}`,
      cookie,
    ),
  );
  return {
    data: parsePageData(record.data, parseOperationalIncidentEvent),
    nextCursor: parseNextCursor(record.nextCursor),
  };
}

export async function acknowledgeOperationalIncident(
  cookie: string,
  input: {
    readonly incidentId: string;
    readonly expectedVersion: number;
    readonly idempotencyKey: string;
  },
): Promise<OperationalIncident> {
  return parseOperationalIncident(
    await apiJson(
      "POST",
      `/v1/operations/incidents/${pathId(input.incidentId)}/acknowledge`,
      cookie,
      { expectedVersion: input.expectedVersion },
      input.idempotencyKey,
    ),
  );
}

export async function resolveOperationalIncident(
  cookie: string,
  input: {
    readonly incidentId: string;
    readonly expectedVersion: number;
    readonly idempotencyKey: string;
  },
): Promise<OperationalIncident> {
  return parseOperationalIncident(
    await apiJson(
      "POST",
      `/v1/operations/incidents/${pathId(input.incidentId)}/resolve`,
      cookie,
      {
        expectedVersion: input.expectedVersion,
        resolutionCode: "operator_resolved",
      },
      input.idempotencyKey,
    ),
  );
}

export async function promoteProductionLive(
  cookie: string,
  input: {
    readonly expectedVersion: number;
    readonly confirmed: true;
    readonly idempotencyKey: string;
  },
): Promise<{ readonly outcome: "promoted" | "already_live" }> {
  const record = object(
    await apiJson(
      "POST",
      "/v1/operations/production-control/promote",
      cookie,
      { confirmed: input.confirmed, expectedVersion: input.expectedVersion },
      input.idempotencyKey,
    ),
  );
  if (record.outcome !== "promoted" && record.outcome !== "already_live") {
    throw new Error("operations_unavailable");
  }
  return { outcome: record.outcome };
}

export async function assignPaymentException(
  cookie: string,
  input: {
    readonly exceptionId: string;
    readonly assignee: string;
    readonly note?: string;
    readonly expectedVersion: number;
    readonly idempotencyKey: string;
  },
): Promise<PaymentException> {
  return parseException(
    await apiJson(
      "POST",
      `/v1/exceptions/${pathId(input.exceptionId)}/assign`,
      cookie,
      {
        assignee: input.assignee,
        ...(input.note === undefined ? {} : { note: input.note }),
        expectedVersion: input.expectedVersion,
      },
      input.idempotencyKey,
    ),
  );
}

export async function resolvePaymentException(
  cookie: string,
  input: {
    readonly exceptionId: string;
    readonly resolutionCode:
      "leave_unapplied" | "reject_payment" | "mark_duplicate" | "ignore";
    readonly note: string;
    readonly expectedVersion: number;
    readonly idempotencyKey: string;
  },
): Promise<PaymentException> {
  return parseException(
    await apiJson(
      "POST",
      `/v1/exceptions/${pathId(input.exceptionId)}/resolve`,
      cookie,
      {
        resolutionCode: input.resolutionCode,
        note: input.note,
        expectedVersion: input.expectedVersion,
      },
      input.idempotencyKey,
    ),
  );
}

export async function createEvidencePack(
  cookie: string,
  invoiceId: string,
  idempotencyKey: string,
): Promise<{ readonly id: string; readonly invoiceId: string }> {
  const record = object(
    await apiJson(
      "POST",
      "/v1/evidence-packs",
      cookie,
      {
        invoiceId: pathId(invoiceId),
      },
      idempotencyKey,
    ),
  );
  if (!isUuid(record.id) || !isUuid(record.invoiceId))
    throw new Error("operations_unavailable");
  return { id: record.id, invoiceId: record.invoiceId };
}

export async function createAccountingExport(
  cookie: string,
  input: {
    readonly format: AccountingExportFormat;
    readonly fromTime: string;
    readonly throughTime: string;
    readonly idempotencyKey: string;
  },
): Promise<{ readonly id: string; readonly format: AccountingExportFormat }> {
  const { idempotencyKey, ...body } = input;
  const record = object(
    await apiJson("POST", "/v1/exports", cookie, body, idempotencyKey),
  );
  if (!isUuid(record.id) || !isExportFormat(record.format))
    throw new Error("operations_unavailable");
  return { id: record.id, format: record.format };
}

export async function downloadOperationFile(
  cookie: string,
  path: string,
  accept: "application/json" | "application/pdf" | "text/csv",
): Promise<Response> {
  if (
    !path.startsWith("/v1/evidence-packs/") &&
    !path.startsWith("/v1/exports/")
  )
    throw new Error("invalid_download_path");
  return fetch(new URL(path, apiOrigin()), {
    method: "GET",
    cache: "no-store",
    redirect: "error",
    headers: requestHeaders(cookie, accept),
    signal: AbortSignal.timeout(60_000),
  });
}

async function apiJson(
  method: "GET" | "POST",
  path: string,
  cookie: string,
  body?: unknown,
  idempotencyKey?: string,
): Promise<unknown> {
  const response = await fetch(new URL(path, apiOrigin()), {
    method,
    cache: "no-store",
    redirect: "error",
    headers: requestHeaders(cookie, "application/json", idempotencyKey),
    signal: AbortSignal.timeout(10_000),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await boundedJson(response);
  if (!response.ok) throw new OperationsApiError(apiErrorCode(value));
  return value;
}

function requestHeaders(
  cookie: string,
  accept: string,
  idempotencyKey?: string,
): Headers {
  const headers = new Headers({
    accept,
    "x-request-id": randomUUID(),
    ...(idempotencyKey === undefined
      ? {}
      : { "content-type": "application/json" }),
  });
  if (cookie !== "") headers.set("cookie", cookie);
  if (idempotencyKey !== undefined) {
    if (!/^[\x21-\x7e]{16,128}$/u.test(idempotencyKey))
      throw new Error("invalid_idempotency_key");
    headers.set("idempotency-key", idempotencyKey);
    headers.set("origin", webOrigin());
  }
  return headers;
}

async function boundedJson(response: Response): Promise<unknown> {
  if (
    response.headers.get("content-type")?.split(";", 1)[0] !==
    "application/json"
  )
    throw new Error("operations_unavailable");
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("operations_unavailable");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > MAX_JSON_BYTES) {
        await reader.cancel();
        throw new Error("operations_unavailable");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("operations_unavailable");
  }
}

function parseException(value: unknown): PaymentException {
  const record = object(value);
  const nullableStrings = [
    record.assignedTo,
    record.resolutionCode,
    record.resolutionNote,
    record.resolvedBy,
    record.resolvedAt,
  ];
  if (
    !isUuid(record.id) ||
    (record.invoiceId !== null && !isUuid(record.invoiceId)) ||
    !isUuid(record.attemptId) ||
    !boundedString(record.eventId, 256) ||
    !boundedString(record.signature, 128) ||
    !/^(0|[1-9][0-9]{0,19})$/u.test(String(record.amountBaseUnits)) ||
    (record.assetSymbol !== null &&
      !["USDC", "USDT"].includes(String(record.assetSymbol))) ||
    !/^[1-9A-HJ-NP-Za-km-z]{32,64}$/u.test(String(record.mint)) ||
    !Number.isSafeInteger(record.decimals) ||
    Number(record.decimals) < 0 ||
    Number(record.decimals) > 18 ||
    !boundedString(record.ruleCode, 128) ||
    !boundedString(record.ruleVersion, 32) ||
    !isReviewState(record.reviewState) ||
    nullableStrings.some(
      (item) => item !== null && !boundedString(item, 1_024),
    ) ||
    !Number.isSafeInteger(record.version) ||
    Number(record.version) < 1 ||
    !isTimestamp(record.createdAt)
  )
    throw new Error("operations_unavailable");
  return record as unknown as PaymentException;
}

function parseProductionControl(value: unknown): ProductionControlView {
  const record = object(value);
  const status = object(record.status);
  const evaluation = object(record.evaluation);
  const prerequisites = object(evaluation.prerequisites);
  const capabilities = object(record.capabilities);
  const promotedAt = nullableTimestamp(status.promotedAt);
  if (
    !["shadow", "live"].includes(String(status.activationMode)) ||
    !positiveInteger(status.version) ||
    promotedAt === undefined ||
    !exactTimestamp(status.createdAt) ||
    !exactTimestamp(status.updatedAt) ||
    typeof evaluation.eligible !== "boolean" ||
    !Array.isArray(evaluation.blockers) ||
    evaluation.blockers.length > 4 ||
    !evaluation.blockers.every(isPromotionBlocker) ||
    typeof prerequisites.completeWatchCoverage !== "boolean" ||
    typeof prerequisites.freshWorkerHeartbeat !== "boolean" ||
    typeof prerequisites.twoActiveProductionRpcRoles !== "boolean" ||
    typeof prerequisites.noOpenCriticalIncident !== "boolean" ||
    typeof capabilities.canManageIncidents !== "boolean" ||
    typeof capabilities.canPromoteProduction !== "boolean"
  ) {
    throw new Error("operations_unavailable");
  }
  return {
    status: {
      activationMode: status.activationMode as "shadow" | "live",
      version: status.version as number,
      promotedAt,
      createdAt: status.createdAt,
      updatedAt: status.updatedAt,
    },
    evaluation: {
      eligible: evaluation.eligible,
      blockers: [...evaluation.blockers] as PromotionBlocker[],
      prerequisites: {
        completeWatchCoverage: prerequisites.completeWatchCoverage,
        freshWorkerHeartbeat: prerequisites.freshWorkerHeartbeat,
        twoActiveProductionRpcRoles: prerequisites.twoActiveProductionRpcRoles,
        noOpenCriticalIncident: prerequisites.noOpenCriticalIncident,
      },
    },
    capabilities: {
      canManageIncidents: capabilities.canManageIncidents,
      canPromoteProduction: capabilities.canPromoteProduction,
    },
  };
}

function parseOperationalHealth(value: unknown): OperationalHealthSnapshot {
  const record = object(value);
  if (
    !Array.isArray(record.measurements) ||
    record.measurements.length > 7 ||
    !nonNegativeInteger(record.openWarningCount) ||
    !nonNegativeInteger(record.openCriticalCount) ||
    !exactTimestamp(record.generatedAt)
  ) {
    throw new Error("operations_unavailable");
  }
  return {
    measurements: record.measurements.map((measurement) => {
      const item = object(measurement);
      if (
        !isMeasurementKind(item.kind) ||
        !["count", "seconds", "milliseconds"].includes(String(item.unit)) ||
        item.windowSeconds !== 300 ||
        !exactTimestamp(item.bucketStart) ||
        typeof item.value !== "number" ||
        !Number.isFinite(item.value) ||
        item.value < 0 ||
        !nonNegativeInteger(item.sampleCount) ||
        !exactTimestamp(item.generatedAt)
      ) {
        throw new Error("operations_unavailable");
      }
      return {
        kind: item.kind,
        unit: item.unit as "count" | "seconds" | "milliseconds",
        windowSeconds: 300 as const,
        bucketStart: item.bucketStart,
        value: item.value,
        sampleCount: item.sampleCount,
        generatedAt: item.generatedAt,
      };
    }),
    openWarningCount: record.openWarningCount,
    openCriticalCount: record.openCriticalCount,
    generatedAt: record.generatedAt,
  };
}

function parseOperationalIncident(value: unknown): OperationalIncident {
  const record = object(value);
  const acknowledgedAt = nullableTimestamp(record.acknowledgedAt);
  const resolvedAt = nullableTimestamp(record.resolvedAt);
  if (
    !isUuid(record.id) ||
    !isIncidentKind(record.kind) ||
    !["warning", "critical"].includes(String(record.severity)) ||
    !isIncidentState(record.state) ||
    !positiveInteger(record.version) ||
    !exactTimestamp(record.firstObservedAt) ||
    !exactTimestamp(record.lastObservedAt) ||
    !positiveInteger(record.occurrenceCount) ||
    acknowledgedAt === undefined ||
    !nullableActorKind(record.acknowledgedActorKind) ||
    resolvedAt === undefined ||
    !nullableActorKind(record.resolvedActorKind) ||
    !["condition_cleared", "operator_resolved", null].includes(
      record.resolutionCode as string | null,
    ) ||
    !exactTimestamp(record.createdAt) ||
    !exactTimestamp(record.updatedAt)
  ) {
    throw new Error("operations_unavailable");
  }
  return {
    id: record.id,
    kind: record.kind,
    severity: record.severity as "warning" | "critical",
    state: record.state,
    version: record.version,
    firstObservedAt: record.firstObservedAt,
    lastObservedAt: record.lastObservedAt,
    occurrenceCount: record.occurrenceCount,
    acknowledgedAt,
    acknowledgedActorKind: record.acknowledgedActorKind as
      "system" | "session" | "api_key" | null,
    resolvedAt,
    resolvedActorKind: record.resolvedActorKind as
      "system" | "session" | "api_key" | null,
    resolutionCode: record.resolutionCode as
      "condition_cleared" | "operator_resolved" | null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function parseOperationalIncidentEvent(
  value: unknown,
): OperationalIncidentEvent {
  const record = object(value);
  if (
    !isUuid(record.id) ||
    !isUuid(record.incidentId) ||
    !positiveInteger(record.incidentVersion) ||
    !["opened", "reobserved", "acknowledged", "resolved"].includes(
      String(record.action),
    ) ||
    !["open", "acknowledged", null].includes(
      record.fromState as string | null,
    ) ||
    !isIncidentState(record.toState) ||
    !positiveInteger(record.occurrenceCount) ||
    !["system", "session", "api_key"].includes(String(record.actorKind)) ||
    !exactTimestamp(record.occurredAt) ||
    !exactTimestamp(record.createdAt)
  ) {
    throw new Error("operations_unavailable");
  }
  return {
    id: record.id,
    incidentId: record.incidentId,
    incidentVersion: record.incidentVersion,
    action: record.action as OperationalIncidentEvent["action"],
    fromState: record.fromState as OperationalIncidentEvent["fromState"],
    toState: record.toState,
    occurrenceCount: record.occurrenceCount,
    actorKind: record.actorKind as OperationalIncidentEvent["actorKind"],
    occurredAt: record.occurredAt,
    createdAt: record.createdAt,
  };
}

function operationalQuery(filters: {
  readonly limit?: number;
  readonly state?: OperationalIncidentState;
  readonly kind?: OperationalIncidentKind;
  readonly cursor?: string;
}): URLSearchParams {
  const limit = filters.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new Error("invalid_operational_filter");
  const query = new URLSearchParams({ limit: String(limit) });
  if (filters.state !== undefined) {
    if (!isIncidentState(filters.state))
      throw new Error("invalid_operational_filter");
    query.set("state", filters.state);
  }
  if (filters.kind !== undefined) {
    if (!isIncidentKind(filters.kind))
      throw new Error("invalid_operational_filter");
    query.set("kind", filters.kind);
  }
  if (filters.cursor !== undefined) {
    if (filters.cursor.length < 16 || filters.cursor.length > 1_024)
      throw new Error("invalid_operational_filter");
    query.set("cursor", filters.cursor);
  }
  return query;
}

function parsePageData<T>(
  value: unknown,
  parse: (item: unknown) => T,
): readonly T[] {
  if (!Array.isArray(value) || value.length > 100)
    throw new Error("operations_unavailable");
  return value.map(parse);
}

function parseNextCursor(value: unknown): string | null {
  if (
    value !== null &&
    (typeof value !== "string" || value.length < 16 || value.length > 1_024)
  ) {
    throw new Error("operations_unavailable");
  }
  return value;
}

function nullableTimestamp(value: unknown): string | null | undefined {
  return value === null ? null : exactTimestamp(value) ? value : undefined;
}

function exactTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isPromotionBlocker(value: unknown): value is PromotionBlocker {
  return [
    "watch_coverage_incomplete",
    "worker_heartbeat_stale",
    "production_rpc_roles_incomplete",
    "open_critical_incident",
  ].includes(String(value));
}

function isMeasurementKind(
  value: unknown,
): value is OperationalMeasurementKind {
  return [
    "rpc_consensus_checks",
    "rpc_consensus_disagreements",
    "ingestion_gap_seconds",
    "worker_heartbeat_age_seconds",
    "ledger_mismatches",
    "webhook_dead_letters",
    "webhook_delivery_duration_milliseconds",
  ].includes(String(value));
}

function isIncidentKind(value: unknown): value is OperationalIncidentKind {
  return [
    "rpc_disagreement",
    "ingestion_gap",
    "worker_stale",
    "ledger_mismatch",
    "webhook_dead_letter",
  ].includes(String(value));
}

function isIncidentState(value: unknown): value is OperationalIncidentState {
  return ["open", "acknowledged", "resolved"].includes(String(value));
}

function nullableActorKind(value: unknown): boolean {
  return (
    value === null || ["system", "session", "api_key"].includes(String(value))
  );
}

function webOrigin(): string {
  const value = process.env.PAYOPS_WEB_ORIGIN;
  if (typeof value !== "string") throw new Error("operations_unavailable");
  const url = new URL(value);
  const local =
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (!local && url.protocol !== "https:") ||
    url.origin !== value ||
    url.username !== "" ||
    url.password !== ""
  )
    throw new Error("operations_unavailable");
  return url.origin;
}

function apiOrigin(): string {
  const value = process.env.PAYOPS_API_ORIGIN;
  if (typeof value !== "string") throw new Error("operations_unavailable");
  const url = new URL(value);
  const local =
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (!local && url.protocol !== "https:") ||
    url.origin !== value ||
    url.username !== "" ||
    url.password !== ""
  )
    throw new Error("operations_unavailable");
  return url.origin;
}

function pathId(value: string): string {
  if (!UUID.test(value)) throw new Error("invalid_resource_id");
  return encodeURIComponent(value);
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("operations_unavailable");
  return value as Record<string, unknown>;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function boundedString(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" && value.length >= 1 && value.length <= maximum
  );
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isReviewState(value: unknown): value is ExceptionReviewState {
  return [
    "open",
    "assigned",
    "investigating",
    "escalated",
    "resolved",
    "ignored",
  ].includes(String(value));
}

function isExportFormat(value: unknown): value is AccountingExportFormat {
  return [
    "payments_csv",
    "invoices_csv",
    "allocations_csv",
    "journals_csv",
    "quickbooks_csv",
  ].includes(String(value));
}

function apiErrorCode(value: unknown): string {
  try {
    const record = object(value);
    if (boundedString(record.code, 128)) return record.code;
    return record.outcome === "blocked"
      ? "promotion_blocked"
      : "operations_unavailable";
  } catch {
    return "operations_unavailable";
  }
}
