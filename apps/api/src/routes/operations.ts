import type {
  AccountingExportFormat,
  AccountingExportService,
  EvidencePackService,
  ExceptionReviewState,
  ExceptionStore,
  NonFinancialResolutionCode,
  OrganizationPermission,
  RateLimitStore,
} from "@payops/platform";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AuthContextResolver, RequestActor } from "../auth/context.js";
import { errorBody } from "../protocol/api-error.js";
import {
  cursorFilterDigest,
  decodeCursor,
  encodeCursor,
  parseLimit,
} from "../protocol/cursor.js";
import type { IdempotentRouteExecutor } from "../protocol/idempotent-route.js";
import { requestIdFor } from "../protocol/request-context.js";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const exceptionStates = new Set([
  "open",
  "assigned",
  "investigating",
  "escalated",
  "resolved",
  "ignored",
]);
const resolutionCodes = new Set([
  "leave_unapplied",
  "reject_payment",
  "mark_duplicate",
  "ignore",
]);
const exportFormats = new Set([
  "payments_csv",
  "invoices_csv",
  "allocations_csv",
  "journals_csv",
  "quickbooks_csv",
]);

export function registerOperationRoutes(
  server: FastifyInstance,
  dependencies: OperationDependencies,
): void {
  server.get("/v1/exceptions", async (request, reply) => {
    const actor = await authenticate(
      request,
      reply,
      dependencies.auth,
      "paymentReview",
    );
    if (actor === null) return reply;
    if (
      !(await consume(
        request,
        reply,
        dependencies.rateLimits,
        actor,
        "exceptions.read",
      ))
    )
      return reply;
    const query = objectRecord(request.query);
    if (!onlyKeys(query, ["limit", "cursor", "state"]))
      return invalidCursor(request, reply);
    const state = optionalState(query.state);
    if (query.state !== undefined && state === undefined)
      return invalidCursor(request, reply);
    const filterDigest = cursorFilterDigest({
      endpoint: "exceptions.list",
      organizationId: actor.organizationId,
      sort: "created_desc",
      filters: { state: state ?? null },
    });
    try {
      const limit = parseLimit(query.limit);
      const after =
        query.cursor === undefined
          ? undefined
          : typeof query.cursor === "string"
            ? decodeCursor(query.cursor, filterDigest)
            : (() => {
                throw new Error("invalid cursor");
              })();
      const rows = await dependencies.exceptions.list({
        organizationId: actor.organizationId,
        actorId: actor.actorId,
        limit: limit + 1,
        ...(state === undefined ? {} : { state }),
        ...(after === undefined ? {} : { after }),
      });
      const data = rows.slice(0, limit);
      const last = data.at(-1);
      return reply.send({
        data,
        nextCursor:
          rows.length > limit && last !== undefined
            ? encodeCursor(
                { createdAt: last.createdAt, id: last.id },
                filterDigest,
              )
            : null,
      });
    } catch {
      return invalidCursor(request, reply);
    }
  });

  server.get("/v1/exceptions/:exceptionId/history", async (request, reply) => {
    const actor = await authenticate(
      request,
      reply,
      dependencies.auth,
      "paymentReview",
    );
    if (actor === null) return reply;
    if (
      !(await consume(
        request,
        reply,
        dependencies.rateLimits,
        actor,
        "exceptions.read",
      ))
    )
      return reply;
    const exceptionId = pathId(request.params, "exceptionId");
    if (exceptionId === null)
      return notFound(request, reply, "exception_not_found");
    const data = await dependencies.exceptions.history({
      organizationId: actor.organizationId,
      actorId: actor.actorId,
      exceptionId,
    });
    if (data === null) return notFound(request, reply, "exception_not_found");
    return reply.send({ data });
  });

  server.post("/v1/exceptions/:exceptionId/assign", async (request, reply) => {
    const actor = await authenticate(
      request,
      reply,
      dependencies.auth,
      "paymentReview",
    );
    if (actor === null) return reply;
    if (
      !(await consume(
        request,
        reply,
        dependencies.rateLimits,
        actor,
        "exceptions.write",
      ))
    )
      return reply;
    const exceptionId = pathId(request.params, "exceptionId");
    const body = objectRecord(request.body);
    if (
      exceptionId === null ||
      !onlyKeys(body, ["assignee", "note", "expectedVersion"]) ||
      typeof body.assignee !== "string" ||
      (body.note !== undefined && typeof body.note !== "string") ||
      !positiveSafeInteger(body.expectedVersion)
    )
      return invalidRequest(request, reply);
    return dependencies.idempotency.execute(
      request,
      reply,
      actor,
      "exceptions.assign",
      { exceptionId },
      body,
      async (committer) =>
        operationResult(request, async () => ({
          status: 200,
          body: await dependencies.exceptions.assign({
            organizationId: actor.organizationId,
            actorKind: actor.kind,
            actorId: actor.actorId,
            exceptionId,
            assignee: body.assignee as string,
            ...(body.note === undefined ? {} : { note: body.note as string }),
            expectedVersion: body.expectedVersion as number,
            now: new Date(),
            auditRequestId: requestIdFor(request),
            idempotency: committer,
          }),
          idempotencyCompleted: true as const,
        })),
    );
  });

  registerExceptionTransition(
    server,
    dependencies,
    "/v1/exceptions/:exceptionId/investigate",
    "startInvestigation",
    "exceptions.investigate",
  );
  registerExceptionTransition(
    server,
    dependencies,
    "/v1/exceptions/:exceptionId/escalate",
    "escalate",
    "exceptions.escalate",
  );
  registerExceptionTransition(
    server,
    dependencies,
    "/v1/exceptions/:exceptionId/reopen",
    "reopen",
    "exceptions.reopen",
  );

  server.post("/v1/exceptions/:exceptionId/resolve", async (request, reply) => {
    const actor = await authenticate(
      request,
      reply,
      dependencies.auth,
      "paymentReview",
    );
    if (actor === null) return reply;
    if (
      !(await consume(
        request,
        reply,
        dependencies.rateLimits,
        actor,
        "exceptions.write",
      ))
    )
      return reply;
    const exceptionId = pathId(request.params, "exceptionId");
    const body = objectRecord(request.body);
    if (
      exceptionId === null ||
      !onlyKeys(body, ["resolutionCode", "note", "expectedVersion"]) ||
      typeof body.resolutionCode !== "string" ||
      !resolutionCodes.has(body.resolutionCode) ||
      typeof body.note !== "string" ||
      !positiveSafeInteger(body.expectedVersion)
    )
      return invalidRequest(request, reply);
    return dependencies.idempotency.execute(
      request,
      reply,
      actor,
      "exceptions.resolve",
      { exceptionId },
      body,
      async (committer) =>
        operationResult(request, async () => ({
          status: 200,
          body: await dependencies.exceptions.resolve({
            organizationId: actor.organizationId,
            actorKind: actor.kind,
            actorId: actor.actorId,
            exceptionId,
            resolutionCode: body.resolutionCode as NonFinancialResolutionCode,
            note: body.note as string,
            expectedVersion: body.expectedVersion as number,
            now: new Date(),
            auditRequestId: requestIdFor(request),
            idempotency: committer,
          }),
          idempotencyCompleted: true as const,
        })),
    );
  });

  server.post("/v1/evidence-packs", async (request, reply) => {
    const actor = await authenticate(
      request,
      reply,
      dependencies.auth,
      "accountingRead",
    );
    if (actor === null) return reply;
    if (
      !(await consume(
        request,
        reply,
        dependencies.rateLimits,
        actor,
        "evidence.write",
      ))
    )
      return reply;
    const body = objectRecord(request.body);
    if (
      !onlyKeys(body, ["invoiceId"]) ||
      typeof body.invoiceId !== "string" ||
      !uuidPattern.test(body.invoiceId)
    ) {
      return invalidRequest(request, reply);
    }
    if (dependencies.evidence === undefined) {
      return reply
        .code(503)
        .send(
          errorBody(
            request,
            "evidence_signing_unavailable",
            "Evidence signing is unavailable",
          ),
        );
    }
    return dependencies.idempotency.execute(
      request,
      reply,
      actor,
      "evidence.generate",
      {},
      body,
      async (committer) =>
        operationResult(request, async () => {
          const pack = await dependencies.evidence!.generate({
            organizationId: actor.organizationId,
            actorKind: actor.kind,
            actorId: actor.actorId,
            invoiceId: body.invoiceId as string,
            now: new Date(),
            auditRequestId: requestIdFor(request),
            idempotency: {
              committer,
              status: 201,
              responseBody: evidenceMetadata,
            },
          });
          return {
            status: 201,
            body: evidenceMetadata(pack),
            idempotencyCompleted: true as const,
          };
        }),
    );
  });

  server.get("/v1/evidence-packs/:evidencePackId", async (request, reply) => {
    const actor = await authenticate(
      request,
      reply,
      dependencies.auth,
      "accountingRead",
    );
    if (actor === null) return reply;
    if (
      !(await consume(
        request,
        reply,
        dependencies.rateLimits,
        actor,
        "evidence.read",
      ))
    )
      return reply;
    const evidencePackId = pathId(request.params, "evidencePackId");
    const query = objectRecord(request.query);
    const format = query.format;
    if (
      evidencePackId === null ||
      !onlyKeys(query, ["format"]) ||
      (format !== "json" && format !== "pdf")
    ) {
      return notFound(request, reply, "evidence_not_found");
    }
    const pack = await dependencies.evidence?.get({
      organizationId: actor.organizationId,
      actorId: actor.actorId,
      evidencePackId,
    });
    if (pack === undefined || pack === null)
      return notFound(request, reply, "evidence_not_found");
    const bytes = format === "pdf" ? pack.pdfBytes : pack.manifestBytes;
    reply.header("cache-control", "private, no-store");
    reply.header(
      "content-disposition",
      `attachment; filename="payops-evidence-${pack.id}.${format}"`,
    );
    reply.header("x-payops-manifest-digest", pack.manifestDigest);
    reply.header("x-payops-signing-key-id", pack.signingKeyId);
    reply.header(
      "x-payops-signature",
      Buffer.from(pack.signature).toString("base64url"),
    );
    return reply
      .type(format === "pdf" ? "application/pdf" : "application/json")
      .send(Buffer.from(bytes));
  });

  server.get(
    "/v1/evidence-packs/:evidencePackId/verification",
    async (request, reply) => {
      const actor = await authenticate(
        request,
        reply,
        dependencies.auth,
        "accountingRead",
      );
      if (actor === null) return reply;
      if (
        !(await consume(
          request,
          reply,
          dependencies.rateLimits,
          actor,
          "evidence.read",
        ))
      )
        return reply;
      const evidencePackId = pathId(request.params, "evidencePackId");
      if (evidencePackId === null)
        return notFound(request, reply, "evidence_not_found");
      const pack = await dependencies.evidence?.get({
        organizationId: actor.organizationId,
        actorId: actor.actorId,
        evidencePackId,
      });
      if (pack === undefined || pack === null)
        return notFound(request, reply, "evidence_not_found");
      reply.header("cache-control", "private, no-store");
      return reply.send({
        evidencePackId: pack.id,
        algorithm: "Ed25519",
        digestAlgorithm: "SHA-256",
        manifestDigest: pack.manifestDigest,
        signature: Buffer.from(pack.signature).toString("base64url"),
        signingKeyId: pack.signingKeyId,
        publicKeyPem: pack.publicKeyPem,
      });
    },
  );

  server.post("/v1/exports", async (request, reply) => {
    const actor = await authenticate(
      request,
      reply,
      dependencies.auth,
      "accountingRead",
    );
    if (actor === null) return reply;
    if (
      !(await consume(
        request,
        reply,
        dependencies.rateLimits,
        actor,
        "exports.write",
      ))
    )
      return reply;
    const body = objectRecord(request.body);
    if (
      !onlyKeys(body, ["format", "fromTime", "throughTime"]) ||
      typeof body.format !== "string" ||
      !exportFormats.has(body.format) ||
      typeof body.fromTime !== "string" ||
      typeof body.throughTime !== "string"
    )
      return invalidRequest(request, reply);
    const fromTime = exactDate(body.fromTime);
    const throughTime = exactDate(body.throughTime);
    if (fromTime === null || throughTime === null)
      return invalidRequest(request, reply);
    return dependencies.idempotency.execute(
      request,
      reply,
      actor,
      "exports.generate",
      {},
      body,
      async (committer) =>
        operationResult(request, async () => {
          const generated = await dependencies.exports.generate({
            organizationId: actor.organizationId,
            actorKind: actor.kind,
            actorId: actor.actorId,
            format: body.format as AccountingExportFormat,
            fromTime,
            throughTime,
            now: new Date(),
            auditRequestId: requestIdFor(request),
            idempotency: {
              committer,
              status: 201,
              responseBody: (record) => ({
                ...exportMetadata(record),
                downloadUrl: `/v1/exports/${record.id}`,
              }),
            },
          });
          return {
            status: 201,
            body: {
              ...exportMetadata(generated),
              downloadUrl: `/v1/exports/${generated.id}`,
            },
            idempotencyCompleted: true as const,
          };
        }),
    );
  });

  server.get("/v1/exports/:exportId", async (request, reply) => {
    const actor = await authenticate(
      request,
      reply,
      dependencies.auth,
      "accountingRead",
    );
    if (actor === null) return reply;
    if (
      !(await consume(
        request,
        reply,
        dependencies.rateLimits,
        actor,
        "exports.read",
      ))
    )
      return reply;
    const exportId = pathId(request.params, "exportId");
    if (exportId === null) return notFound(request, reply, "export_not_found");
    const generated = await dependencies.exports.get({
      organizationId: actor.organizationId,
      actorId: actor.actorId,
      exportId,
    });
    if (generated === null) return notFound(request, reply, "export_not_found");
    reply.header("cache-control", "private, no-store");
    reply.header(
      "content-disposition",
      `attachment; filename="payops-${generated.format}-${generated.id}.csv"`,
    );
    reply.header("x-payops-content-digest", generated.contentDigest);
    return reply
      .type("text/csv; charset=utf-8")
      .send(Buffer.from(generated.contentBytes));
  });
}

interface OperationDependencies {
  readonly auth: AuthContextResolver;
  readonly rateLimits: Pick<RateLimitStore, "consume">;
  readonly idempotency: Pick<IdempotentRouteExecutor, "execute">;
  readonly exceptions: Pick<
    ExceptionStore,
    | "list"
    | "history"
    | "assign"
    | "resolve"
    | "startInvestigation"
    | "escalate"
    | "reopen"
  >;
  readonly evidence?: Pick<EvidencePackService, "generate" | "get">;
  readonly exports: Pick<AccountingExportService, "generate" | "get">;
}

function registerExceptionTransition(
  server: FastifyInstance,
  dependencies: OperationDependencies,
  path: string,
  operation: "startInvestigation" | "escalate" | "reopen",
  idempotencyScope: string,
): void {
  server.post(path, async (request, reply) => {
    const actor = await authenticate(
      request,
      reply,
      dependencies.auth,
      "paymentReview",
    );
    if (actor === null) return reply;
    if (
      !(await consume(
        request,
        reply,
        dependencies.rateLimits,
        actor,
        "exceptions.write",
      ))
    )
      return reply;
    const exceptionId = pathId(request.params, "exceptionId");
    const body = objectRecord(request.body);
    if (
      exceptionId === null ||
      !onlyKeys(body, ["reasonCode", "note", "expectedVersion"]) ||
      typeof body.reasonCode !== "string" ||
      (body.note !== undefined && typeof body.note !== "string") ||
      !positiveSafeInteger(body.expectedVersion)
    )
      return invalidRequest(request, reply);
    return dependencies.idempotency.execute(
      request,
      reply,
      actor,
      idempotencyScope,
      { exceptionId },
      body,
      async (committer) =>
        operationResult(request, async () => ({
          status: 200,
          body: await dependencies.exceptions[operation]({
            organizationId: actor.organizationId,
            actorKind: actor.kind,
            actorId: actor.actorId,
            exceptionId,
            reasonCode: body.reasonCode as string,
            ...(body.note === undefined ? {} : { note: body.note as string }),
            expectedVersion: body.expectedVersion as number,
            now: new Date(),
            auditRequestId: requestIdFor(request),
            idempotency: committer,
          }),
          idempotencyCompleted: true as const,
        })),
    );
  });
}

function evidenceMetadata(
  pack: Awaited<ReturnType<EvidencePackService["generate"]>>,
) {
  return {
    id: pack.id,
    invoiceId: pack.invoiceId,
    schemaVersion: pack.schemaVersion,
    manifestDigest: pack.manifestDigest,
    signature: Buffer.from(pack.signature).toString("base64url"),
    signingKeyId: pack.signingKeyId,
    generatedAt: pack.generatedAt,
    jsonUrl: `/v1/evidence-packs/${pack.id}?format=json`,
    pdfUrl: `/v1/evidence-packs/${pack.id}?format=pdf`,
    verificationUrl: `/v1/evidence-packs/${pack.id}/verification`,
  };
}

function exportMetadata(
  record: Awaited<ReturnType<AccountingExportService["generate"]>>,
) {
  return {
    id: record.id,
    format: record.format,
    fromTime: record.fromTime,
    throughTime: record.throughTime,
    contentDigest: record.contentDigest,
    rowCount: record.rowCount,
    generatedAt: record.generatedAt,
  };
}

async function operationResult(
  request: FastifyRequest,
  operation: () => Promise<{ readonly status: number; readonly body: unknown }>,
) {
  try {
    return await operation();
  } catch (error) {
    const code = safeCode(error);
    if (code === null || code.endsWith("_unavailable")) throw error;
    return {
      status: code.endsWith("_not_found")
        ? 404
        : code.endsWith("_conflict") ||
            code === "exception_closed" ||
            code === "invalid_exception_transition"
          ? 409
          : 400,
      body: errorBody(request, code, "Operation could not be completed"),
    };
  }
}

async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply,
  auth: AuthContextResolver,
  permission: OrganizationPermission,
): Promise<RequestActor | null> {
  try {
    const actor = await auth.resolve(toHeaders(request));
    if (!actor.permissions[permission]) {
      reply
        .code(403)
        .send(errorBody(request, "forbidden", "Permission is required"));
      return null;
    }
    return actor;
  } catch {
    reply
      .code(401)
      .send(
        errorBody(
          request,
          "authentication_required",
          "Authentication is required",
        ),
      );
    return null;
  }
}

async function consume(
  request: FastifyRequest,
  reply: FastifyReply,
  store: Pick<RateLimitStore, "consume">,
  actor: RequestActor,
  routeGroup: string,
): Promise<boolean> {
  const result = await store.consume({
    organizationId: actor.organizationId,
    actorKind: actor.kind,
    actorId: actor.actorId,
    routeGroup,
    now: new Date(),
  });
  if (result.allowed) return true;
  reply.header("retry-after", result.retryAfterSeconds);
  reply
    .code(429)
    .send(errorBody(request, "rate_limit_exceeded", "Rate limit exceeded"));
  return false;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function onlyKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(record).every((key) => allowedSet.has(key));
}

function optionalState(value: unknown): ExceptionReviewState | undefined {
  return typeof value === "string" && exceptionStates.has(value)
    ? (value as ExceptionReviewState)
    : undefined;
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function pathId(value: unknown, key: string): string | null {
  if (value === null || typeof value !== "object") return null;
  const id = (value as Record<string, unknown>)[key];
  return typeof id === "string" && uuidPattern.test(id) ? id : null;
}

function exactDate(value: string): Date | null {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value
    ? date
    : null;
}

function safeCode(error: unknown): string | null {
  if (
    error === null ||
    (typeof error !== "object" && typeof error !== "function")
  )
    return null;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, "code");
    return descriptor !== undefined &&
      "value" in descriptor &&
      typeof descriptor.value === "string" &&
      /^[a-z][a-z0-9_]{0,127}$/.test(descriptor.value)
      ? descriptor.value
      : null;
  } catch {
    return null;
  }
}

function invalidRequest(request: FastifyRequest, reply: FastifyReply) {
  return reply
    .code(400)
    .send(errorBody(request, "invalid_request", "Request body is invalid"));
}

function invalidCursor(request: FastifyRequest, reply: FastifyReply) {
  return reply
    .code(400)
    .send(errorBody(request, "invalid_cursor", "List cursor is invalid"));
}

function notFound(request: FastifyRequest, reply: FastifyReply, code: string) {
  return reply
    .code(404)
    .send(errorBody(request, code, "Resource was not found"));
}

function toHeaders(request: FastifyRequest): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === "string") headers.append(name, value);
    else if (Array.isArray(value))
      for (const entry of value) headers.append(name, entry);
  }
  return headers;
}
