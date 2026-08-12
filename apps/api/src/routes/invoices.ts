import {
  InvoiceStore,
  type InvoiceLineInput,
  type InvoiceStatus,
  type OrganizationPermission,
  type RateLimitStore,
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
import { IdempotentRouteExecutor } from "../protocol/idempotent-route.js";
import { requestIdFor } from "../protocol/request-context.js";

const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function registerInvoiceRoutes(
  server: FastifyInstance,
  dependencies: {
    readonly auth: AuthContextResolver;
    readonly invoices: InvoiceStore;
    readonly idempotency: IdempotentRouteExecutor;
    readonly rateLimits: RateLimitStore;
  },
): void {
  server.post("/v1/invoices", async (request, reply) => {
    const actor = await authenticate(
      request,
      reply,
      dependencies.auth,
      "invoiceWrite",
    );
    if (actor === null) return reply;
    if (
      !(await consume(
        request,
        reply,
        dependencies.rateLimits,
        actor,
        "invoice.write",
      ))
    )
      return reply;
    const body = parseCreateBody(request.body);
    if (body === null) return invalidRequest(request, reply);
    return dependencies.idempotency.execute(
      request,
      reply,
      actor,
      "invoices.create",
      {},
      body,
      async (idempotency) =>
        invoiceOperation(request, async () => {
          const responseBody = await dependencies.invoices.create({
            organizationId: actor.organizationId,
            actorKind: actor.kind,
            actorId: actor.actorId,
            ...body,
            now: new Date(),
            auditRequestId: requestIdFor(request),
            idempotency,
          });
          return {
            status: 201,
            body: responseBody,
            idempotencyCompleted: true,
          };
        }),
    );
  });

  server.get("/v1/invoices", async (request, reply) => {
    const actor = await authenticate(
      request,
      reply,
      dependencies.auth,
      "invoiceRead",
    );
    if (actor === null) return reply;
    if (
      !(await consume(
        request,
        reply,
        dependencies.rateLimits,
        actor,
        "invoice.read",
      ))
    )
      return reply;
    const query = objectRecord(request.query);
    if (!onlyKeys(query, ["limit", "cursor", "status", "customerId"])) {
      return invalidCursor(request, reply);
    }
    const status = parseStatus(query.status);
    const customerId = optionalString(query.customerId);
    if (query.status !== undefined && status === undefined)
      return invalidCursor(request, reply);
    if (query.customerId !== undefined && customerId === undefined)
      return invalidCursor(request, reply);
    const filterDigest = cursorFilterDigest({
      endpoint: "invoices.list",
      organizationId: actor.organizationId,
      sort: "created_desc",
      filters: { status: status ?? null, customerId: customerId ?? null },
    });
    let limit: number;
    let after: { readonly createdAt: string; readonly id: string } | undefined;
    try {
      limit = parseLimit(query.limit);
      if (query.cursor !== undefined) {
        if (typeof query.cursor !== "string") throw new Error("invalid cursor");
        after = decodeCursor(query.cursor, filterDigest);
      }
    } catch {
      return invalidCursor(request, reply);
    }
    try {
      const rows = await dependencies.invoices.list({
        organizationId: actor.organizationId,
        actorId: actor.actorId,
        limit: limit + 1,
        ...(status === undefined ? {} : { status }),
        ...(customerId === undefined ? {} : { customerId }),
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

  server.get("/v1/invoices/:invoiceId", async (request, reply) => {
    const actor = await authenticate(
      request,
      reply,
      dependencies.auth,
      "invoiceRead",
    );
    if (actor === null) return reply;
    if (
      !(await consume(
        request,
        reply,
        dependencies.rateLimits,
        actor,
        "invoice.read",
      ))
    )
      return reply;
    const invoiceId = pathId(request.params, "invoiceId");
    if (invoiceId === null) return notFound(request, reply);
    const invoice = await dependencies.invoices.get({
      organizationId: actor.organizationId,
      actorId: actor.actorId,
      invoiceId,
    });
    return invoice === null ? notFound(request, reply) : reply.send(invoice);
  });

  server.post("/v1/invoices/:invoiceId/issue", async (request, reply) => {
    const actor = await authenticate(
      request,
      reply,
      dependencies.auth,
      "invoiceIssue",
    );
    if (actor === null) return reply;
    if (
      !(await consume(
        request,
        reply,
        dependencies.rateLimits,
        actor,
        "invoice.write",
      ))
    )
      return reply;
    const invoiceId = pathId(request.params, "invoiceId");
    if (invoiceId === null || !isEmptyObject(request.body))
      return invalidRequest(request, reply);
    return dependencies.idempotency.execute(
      request,
      reply,
      actor,
      "invoices.issue",
      { invoiceId },
      {},
      async (idempotency) =>
        invoiceOperation(request, async () => {
          const issued = await dependencies.invoices.issue({
            organizationId: actor.organizationId,
            actorKind: actor.kind,
            actorId: actor.actorId,
            invoiceId,
            now: new Date(),
            auditRequestId: requestIdFor(request),
            idempotency,
          });
          return {
            status: 200,
            body: issued,
            idempotencyCompleted: true,
          };
        }),
    );
  });

  server.post("/v1/invoices/:invoiceId/cancel", async (request, reply) => {
    const actor = await authenticate(
      request,
      reply,
      dependencies.auth,
      "invoiceIssue",
    );
    if (actor === null) return reply;
    if (
      !(await consume(
        request,
        reply,
        dependencies.rateLimits,
        actor,
        "invoice.write",
      ))
    )
      return reply;
    const invoiceId = pathId(request.params, "invoiceId");
    const body = objectRecord(request.body);
    if (
      invoiceId === null ||
      !onlyKeys(body, ["reasonCode"]) ||
      typeof body.reasonCode !== "string"
    )
      return invalidRequest(request, reply);
    return dependencies.idempotency.execute(
      request,
      reply,
      actor,
      "invoices.cancel",
      { invoiceId },
      body,
      async (idempotency) =>
        invoiceOperation(request, async () => {
          const responseBody = await dependencies.invoices.cancel({
            organizationId: actor.organizationId,
            actorKind: actor.kind,
            actorId: actor.actorId,
            invoiceId,
            reasonCode: body.reasonCode as string,
            now: new Date(),
            auditRequestId: requestIdFor(request),
            idempotency,
          });
          return {
            status: 200,
            body: responseBody,
            idempotencyCompleted: true,
          };
        }),
    );
  });
}

async function invoiceOperation(
  request: FastifyRequest,
  operation: () => Promise<{
    readonly status: number;
    readonly body: unknown;
    readonly idempotencyCompleted?: true;
  }>,
): Promise<{
  readonly status: number;
  readonly body: unknown;
  readonly idempotencyCompleted?: true;
}> {
  try {
    return await operation();
  } catch (error) {
    const code = safeCode(error);
    if (
      code === null ||
      code === "invoice_store_unavailable" ||
      (!code.startsWith("invoice_") &&
        !code.startsWith("invalid_invoice_") &&
        !code.endsWith("_not_found") &&
        code !== "invalid_cancellation_reason" &&
        code !== "unsupported_invoice_currency")
    ) {
      throw error;
    }
    const status = code.endsWith("_not_found")
      ? 404
      : code.endsWith("_conflict") ||
          code === "invoice_not_draft" ||
          code === "invoice_already_cancelled" ||
          code === "invoice_has_payment"
        ? 409
        : 400;
    return {
      status,
      body: errorBody(
        request,
        code,
        "Invoice operation could not be completed",
      ),
    };
  }
}

function parseCreateBody(value: unknown): {
  readonly externalId?: string | null;
  readonly customerId: string;
  readonly settlementWalletId: string;
  readonly acceptedAssetSymbols: readonly string[];
  readonly currency: string;
  readonly lines: readonly InvoiceLineInput[];
  readonly dueAt: Date;
  readonly expectedTotals?: {
    readonly subtotalMinorUnits?: string;
    readonly taxMinorUnits?: string;
    readonly totalMinorUnits?: string;
  };
} | null {
  const body = objectRecord(value);
  if (
    !onlyKeys(body, [
      "externalId",
      "customerId",
      "settlementWalletId",
      "acceptedAssetSymbols",
      "currency",
      "lines",
      "dueAt",
      "expectedTotals",
    ]) ||
    typeof body.customerId !== "string" ||
    typeof body.settlementWalletId !== "string" ||
    typeof body.currency !== "string" ||
    typeof body.dueAt !== "string" ||
    !Array.isArray(body.acceptedAssetSymbols) ||
    !body.acceptedAssetSymbols.every((value) => typeof value === "string") ||
    !Array.isArray(body.lines)
  )
    return null;
  const dueAt = new Date(body.dueAt);
  if (!Number.isFinite(dueAt.getTime()) || dueAt.toISOString() !== body.dueAt)
    return null;
  const lines = body.lines.map(parseLine);
  if (lines.some((line) => line === null)) return null;
  const expectedTotals = parseExpectedTotals(body.expectedTotals);
  if (body.expectedTotals !== undefined && expectedTotals === null) return null;
  if (
    body.externalId !== undefined &&
    body.externalId !== null &&
    typeof body.externalId !== "string"
  ) {
    return null;
  }
  return {
    customerId: body.customerId,
    settlementWalletId: body.settlementWalletId,
    acceptedAssetSymbols: body.acceptedAssetSymbols,
    currency: body.currency,
    lines: lines as InvoiceLineInput[],
    dueAt,
    ...(body.externalId === undefined
      ? {}
      : { externalId: body.externalId as string | null }),
    ...(expectedTotals === null ? {} : { expectedTotals }),
  };
}

function parseLine(value: unknown): InvoiceLineInput | null {
  const line = objectRecord(value);
  if (
    !onlyKeys(line, [
      "description",
      "quantity",
      "unitPriceMinorUnits",
      "taxLabel",
      "taxMinorUnits",
    ]) ||
    typeof line.description !== "string" ||
    typeof line.quantity !== "string" ||
    typeof line.unitPriceMinorUnits !== "string" ||
    typeof line.taxMinorUnits !== "string" ||
    (line.taxLabel !== undefined &&
      line.taxLabel !== null &&
      typeof line.taxLabel !== "string")
  )
    return null;
  return {
    description: line.description,
    quantity: line.quantity,
    unitPriceMinorUnits: line.unitPriceMinorUnits,
    taxMinorUnits: line.taxMinorUnits,
    ...(line.taxLabel === undefined
      ? {}
      : { taxLabel: line.taxLabel as string | null }),
  };
}

function parseExpectedTotals(value: unknown): {
  readonly subtotalMinorUnits?: string;
  readonly taxMinorUnits?: string;
  readonly totalMinorUnits?: string;
} | null {
  if (value === undefined) return null;
  const totals = objectRecord(value);
  if (
    !onlyKeys(totals, [
      "subtotalMinorUnits",
      "taxMinorUnits",
      "totalMinorUnits",
    ])
  )
    return null;
  for (const key of [
    "subtotalMinorUnits",
    "taxMinorUnits",
    "totalMinorUnits",
  ] as const) {
    if (totals[key] !== undefined && typeof totals[key] !== "string")
      return null;
  }
  return {
    ...(totals.subtotalMinorUnits === undefined
      ? {}
      : { subtotalMinorUnits: totals.subtotalMinorUnits as string }),
    ...(totals.taxMinorUnits === undefined
      ? {}
      : { taxMinorUnits: totals.taxMinorUnits as string }),
    ...(totals.totalMinorUnits === undefined
      ? {}
      : { totalMinorUnits: totals.totalMinorUnits as string }),
  };
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
  store: RateLimitStore,
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
  const set = new Set(allowed);
  return Object.keys(record).every((key) => set.has(key));
}

function parseStatus(value: unknown): InvoiceStatus | undefined {
  return value === "draft" ||
    value === "issued" ||
    value === "paid" ||
    value === "cancelled"
    ? value
    : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function pathId(value: unknown, key: string): string | null {
  if (value === null || typeof value !== "object") return null;
  const id = (value as Record<string, unknown>)[key];
  return typeof id === "string" && canonicalUuidPattern.test(id) ? id : null;
}

function isEmptyObject(value: unknown): boolean {
  return (
    value === undefined ||
    (value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === 0)
  );
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

function invalidRequest(
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  return reply
    .code(400)
    .send(errorBody(request, "invalid_request", "Request body is invalid"));
}

function invalidCursor(
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  return reply
    .code(400)
    .send(errorBody(request, "invalid_cursor", "List cursor is invalid"));
}

function notFound(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  return reply
    .code(404)
    .send(errorBody(request, "invoice_not_found", "Invoice was not found"));
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
