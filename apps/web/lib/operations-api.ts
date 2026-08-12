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
  if (!response.ok) throw new Error(apiErrorCode(value));
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
    return boundedString(record.code, 128)
      ? record.code
      : "operations_unavailable";
  } catch {
    return "operations_unavailable";
  }
}
