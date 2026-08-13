import type {
  OperationalHealthStore,
  OperationalIncident,
  OperationalIncidentEvent,
  OperationalIncidentKind,
  OperationalIncidentState,
  ProductionControlStore,
  RateLimitStore,
  IdempotencyResponseCommitter,
  PromotionResult,
} from "@payops/platform";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  requireSensitiveSession,
  type AuthContextResolver,
  type RequestActor,
  type SessionActor,
} from "../auth/context.js";
import { errorBody } from "../protocol/api-error.js";
import {
  cursorFilterDigest,
  decodeCursor,
  decodeVersionCursor,
  encodeCursor,
  encodeVersionCursor,
  parseLimit,
} from "../protocol/cursor.js";
import type { IdempotentRouteExecutor } from "../protocol/idempotent-route.js";
import { requestIdFor } from "../protocol/request-context.js";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const incidentStates = new Set(["open", "acknowledged", "resolved"]);
const incidentKinds = new Set([
  "rpc_disagreement",
  "ingestion_gap",
  "worker_stale",
  "ledger_mismatch",
  "webhook_dead_letter",
]);

export interface OperationalRouteDependencies {
  readonly auth: AuthContextResolver;
  readonly rateLimits: Pick<RateLimitStore, "consume">;
  readonly idempotency: Pick<IdempotentRouteExecutor, "execute">;
  readonly productionControls: Pick<
    ProductionControlStore,
    "getStatus" | "evaluatePromotion" | "promoteLive"
  >;
  readonly operationalHealth: Pick<
    OperationalHealthStore,
    | "getSnapshot"
    | "listIncidents"
    | "listIncidentHistory"
    | "acknowledgeIncident"
    | "resolveIncident"
  >;
}

export function registerOperationalHealthRoutes(
  server: FastifyInstance,
  dependencies: OperationalRouteDependencies,
): void {
  server.get("/v1/operations/production-control", async (request, reply) => {
    const actor = await reader(request, reply, dependencies);
    if (actor === null) return reply;
    try {
      const now = new Date();
      const [status, evaluation] = await Promise.all([
        dependencies.productionControls.getStatus({
          organizationId: actor.organizationId,
          actorId: actor.actorId,
        }),
        dependencies.productionControls.evaluatePromotion({
          organizationId: actor.organizationId,
          actorId: actor.actorId,
          now,
        }),
      ]);
      noStore(reply);
      return reply.send({
        status: publicProductionStatus(status),
        evaluation,
        capabilities: operationalCapabilities(actor, now),
      });
    } catch (error) {
      return operationalError(request, reply, error);
    }
  });

  server.get("/v1/operations/health", async (request, reply) => {
    const actor = await reader(request, reply, dependencies);
    if (actor === null) return reply;
    try {
      const snapshot = await dependencies.operationalHealth.getSnapshot({
        organizationId: actor.organizationId,
        actorId: actor.actorId,
      });
      noStore(reply);
      return reply.send(snapshot);
    } catch (error) {
      return operationalError(request, reply, error);
    }
  });

  server.get("/v1/operations/incidents", async (request, reply) => {
    const actor = await reader(request, reply, dependencies);
    if (actor === null) return reply;
    const query = objectRecord(request.query);
    if (!onlyKeys(query, ["limit", "cursor", "state", "kind"])) {
      return invalidCursor(request, reply);
    }
    const state = optionalIncidentState(query.state);
    const kind = optionalIncidentKind(query.kind);
    if (
      (query.state !== undefined && state === undefined) ||
      (query.kind !== undefined && kind === undefined)
    ) {
      return invalidCursor(request, reply);
    }
    const filterDigest = cursorFilterDigest({
      endpoint: "operations.incidents.list",
      organizationId: actor.organizationId,
      sort: "last_observed_desc",
      filters: { state: state ?? null, kind: kind ?? null },
    });
    try {
      const limit = parseLimit(query.limit);
      const cursor =
        query.cursor === undefined
          ? undefined
          : typeof query.cursor === "string"
            ? decodeCursor(query.cursor, filterDigest)
            : invalidCursorValue();
      const page = await dependencies.operationalHealth.listIncidents({
        organizationId: actor.organizationId,
        actorId: actor.actorId,
        limit,
        ...(state === undefined ? {} : { state }),
        ...(kind === undefined ? {} : { kind }),
        ...(cursor === undefined
          ? {}
          : {
              cursor: {
                lastObservedAt: cursor.createdAt,
                id: cursor.id,
              },
            }),
      });
      noStore(reply);
      return reply.send({
        data: page.items.map(publicIncident),
        nextCursor:
          page.nextCursor === null
            ? null
            : encodeCursor(
                {
                  createdAt: page.nextCursor.lastObservedAt,
                  id: page.nextCursor.id,
                },
                filterDigest,
              ),
      });
    } catch (error) {
      return isCursorFailure(error)
        ? invalidCursor(request, reply)
        : operationalError(request, reply, error);
    }
  });

  server.get(
    "/v1/operations/incidents/:incidentId/history",
    async (request, reply) => {
      const actor = await reader(request, reply, dependencies);
      if (actor === null) return reply;
      const incidentId = pathId(request.params, "incidentId");
      if (incidentId === null)
        return notFound(request, reply, "incident_not_found");
      const query = objectRecord(request.query);
      if (!onlyKeys(query, ["limit", "cursor"])) {
        return invalidCursor(request, reply);
      }
      const filterDigest = cursorFilterDigest({
        endpoint: "operations.incidents.history",
        organizationId: actor.organizationId,
        sort: "incident_version_desc",
        filters: { incidentId },
      });
      try {
        const limit = parseLimit(query.limit);
        const cursor =
          query.cursor === undefined
            ? undefined
            : typeof query.cursor === "string"
              ? decodeVersionCursor(query.cursor, filterDigest)
              : invalidCursorValue();
        const page = await dependencies.operationalHealth.listIncidentHistory({
          organizationId: actor.organizationId,
          actorId: actor.actorId,
          incidentId,
          limit,
          ...(cursor === undefined ? {} : { cursor }),
        });
        noStore(reply);
        return reply.send({
          data: page.items.map(publicIncidentEvent),
          nextCursor:
            page.nextCursor === null
              ? null
              : encodeVersionCursor(page.nextCursor, filterDigest),
        });
      } catch (error) {
        return isCursorFailure(error)
          ? invalidCursor(request, reply)
          : operationalError(request, reply, error);
      }
    },
  );

  server.post(
    "/v1/operations/incidents/:incidentId/acknowledge",
    async (request, reply) => {
      const actor = await operator(request, reply, dependencies);
      if (actor === null) return reply;
      const incidentId = pathId(request.params, "incidentId");
      const body = objectRecord(request.body);
      if (
        incidentId === null ||
        !onlyKeys(body, ["expectedVersion"]) ||
        !positiveSafeInteger(body.expectedVersion)
      ) {
        return invalidRequest(request, reply);
      }
      return dependencies.idempotency.execute(
        request,
        reply,
        actor,
        "operations.incidents.acknowledge",
        { incidentId },
        body,
        async (committer) =>
          mutationResult(request, async () => {
            const incident =
              await dependencies.operationalHealth.acknowledgeIncident({
                organizationId: actor.organizationId,
                actorId: actor.actorId,
                actorKind: actor.kind,
                incidentId,
                expectedVersion: body.expectedVersion as number,
                acknowledgedAt: new Date(),
                idempotency: incidentIdempotency(request, committer),
              });
            return {
              status: 200,
              body: publicIncident(incident),
              idempotencyCompleted: true as const,
            };
          }),
      );
    },
  );

  server.post(
    "/v1/operations/incidents/:incidentId/resolve",
    async (request, reply) => {
      const actor = await operator(request, reply, dependencies);
      if (actor === null) return reply;
      const incidentId = pathId(request.params, "incidentId");
      const body = objectRecord(request.body);
      if (
        incidentId === null ||
        !onlyKeys(body, ["expectedVersion", "resolutionCode"]) ||
        !positiveSafeInteger(body.expectedVersion) ||
        body.resolutionCode !== "operator_resolved"
      ) {
        return invalidRequest(request, reply);
      }
      return dependencies.idempotency.execute(
        request,
        reply,
        actor,
        "operations.incidents.resolve",
        { incidentId },
        body,
        async (committer) =>
          mutationResult(request, async () => {
            const incident =
              await dependencies.operationalHealth.resolveIncident({
                organizationId: actor.organizationId,
                actorId: actor.actorId,
                actorKind: actor.kind,
                incidentId,
                expectedVersion: body.expectedVersion as number,
                resolutionCode: "operator_resolved",
                resolvedAt: new Date(),
                idempotency: incidentIdempotency(request, committer),
              });
            return {
              status: 200,
              body: publicIncident(incident),
              idempotencyCompleted: true as const,
            };
          }),
      );
    },
  );

  server.post(
    "/v1/operations/production-control/promote",
    async (request, reply) => {
      const actor = await owner(request, reply, dependencies);
      if (actor === null) return reply;
      const body = objectRecord(request.body);
      if (
        !onlyKeys(body, ["confirmed", "expectedVersion"]) ||
        body.confirmed !== true ||
        !positiveSafeInteger(body.expectedVersion)
      ) {
        return invalidRequest(request, reply);
      }
      return dependencies.idempotency.execute(
        request,
        reply,
        actor,
        "operations.production.promote",
        {},
        body,
        async (committer) =>
          mutationResult(request, async () => {
            const result = await dependencies.productionControls.promoteLive({
              organizationId: actor.organizationId,
              actorKind: actor.kind,
              actorId: actor.actorId,
              auditRequestId: requestIdFor(request),
              expectedVersion: body.expectedVersion as number,
              now: new Date(),
              idempotency: {
                committer,
                response: publicPromotionResponse,
                errorResponse: (code) => mutationErrorResponse(request, code),
              },
            });
            return {
              ...publicPromotionResponse(result),
              idempotencyCompleted: true as const,
            };
          }),
      );
    },
  );
}

function operationalCapabilities(actor: RequestActor, now: Date) {
  const canManageIncidents =
    actor.kind === "session" &&
    (actor.role === "owner" || actor.role === "operator");
  let canPromoteProduction = false;
  if (actor.kind === "session" && actor.role === "owner") {
    try {
      requireSensitiveSession(actor, now, { requireTwoFactor: true });
      canPromoteProduction = true;
    } catch {
      // The mutation independently enforces the same session policy.
    }
  }
  return { canManageIncidents, canPromoteProduction };
}

async function reader(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: OperationalRouteDependencies,
): Promise<RequestActor | null> {
  const actor = await authenticate(request, reply, dependencies.auth);
  if (actor === null) return null;
  if (!actor.permissions.organizationRead) {
    reply
      .code(403)
      .send(errorBody(request, "forbidden", "Permission is required"));
    return null;
  }
  if (
    !(await consume(
      request,
      reply,
      dependencies.rateLimits,
      actor,
      "operations.read",
    ))
  ) {
    return null;
  }
  return actor;
}

async function operator(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: OperationalRouteDependencies,
): Promise<SessionActor | null> {
  const actor = await authenticate(request, reply, dependencies.auth);
  if (actor === null) return null;
  if (
    actor.kind !== "session" ||
    (actor.role !== "owner" && actor.role !== "operator")
  ) {
    reply
      .code(403)
      .send(
        errorBody(
          request,
          "operator_session_required",
          "An owner or operator session is required",
        ),
      );
    return null;
  }
  if (
    !(await consume(
      request,
      reply,
      dependencies.rateLimits,
      actor,
      "operations.write",
    ))
  ) {
    return null;
  }
  return actor;
}

async function owner(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: OperationalRouteDependencies,
): Promise<SessionActor | null> {
  const actor = await authenticate(request, reply, dependencies.auth);
  if (actor === null) return null;
  if (actor.kind !== "session" || actor.role !== "owner") {
    reply
      .code(403)
      .send(
        errorBody(
          request,
          "owner_session_required",
          "An owner session is required",
        ),
      );
    return null;
  }
  try {
    requireSensitiveSession(actor, new Date(), { requireTwoFactor: true });
  } catch {
    reply
      .code(403)
      .send(
        errorBody(
          request,
          "fresh_owner_session_required",
          "A fresh two-factor owner session is required",
        ),
      );
    return null;
  }
  if (
    !(await consume(
      request,
      reply,
      dependencies.rateLimits,
      actor,
      "operations.promote",
    ))
  ) {
    return null;
  }
  return actor;
}

async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply,
  auth: AuthContextResolver,
): Promise<RequestActor | null> {
  try {
    return await auth.resolve(toHeaders(request));
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
  reply.header("x-ratelimit-limit", result.limit);
  reply.header("x-ratelimit-remaining", result.remaining);
  if (result.allowed) return true;
  reply.header("retry-after", result.retryAfterSeconds);
  reply
    .code(429)
    .send(errorBody(request, "rate_limit_exceeded", "Rate limit exceeded"));
  return false;
}

function publicProductionStatus(
  value: Awaited<ReturnType<ProductionControlStore["getStatus"]>>,
) {
  return {
    activationMode: value.activationMode,
    version: value.version,
    promotedAt: value.promotedAt,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function publicIncident(value: OperationalIncident) {
  return {
    id: value.id,
    kind: value.kind,
    severity: value.severity,
    state: value.state,
    version: value.version,
    firstObservedAt: value.firstObservedAt,
    lastObservedAt: value.lastObservedAt,
    occurrenceCount: value.occurrenceCount,
    acknowledgedAt: value.acknowledgedAt,
    acknowledgedActorKind: value.acknowledgedActorKind,
    resolvedAt: value.resolvedAt,
    resolvedActorKind: value.resolvedActorKind,
    resolutionCode: value.resolutionCode,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function publicIncidentEvent(value: OperationalIncidentEvent) {
  return {
    id: value.id,
    incidentId: value.incidentId,
    incidentVersion: value.incidentVersion,
    action: value.action,
    fromState: value.fromState,
    toState: value.toState,
    occurrenceCount: value.occurrenceCount,
    actorKind: value.actorKind,
    occurredAt: value.occurredAt,
    createdAt: value.createdAt,
  };
}

function incidentIdempotency(
  request: FastifyRequest,
  committer: IdempotencyResponseCommitter,
) {
  return {
    committer,
    status: 200,
    responseBody: publicIncident,
    errorResponse: (code: "incident_not_found" | "incident_version_conflict") =>
      mutationErrorResponse(request, code),
  };
}

function publicPromotionResponse(result: PromotionResult) {
  return {
    status: result.outcome === "blocked" ? 409 : 200,
    body:
      result.outcome === "blocked"
        ? {
            outcome: result.outcome,
            status: publicProductionStatus(result.status),
            evaluation: result.evaluation,
          }
        : {
            outcome: result.outcome,
            status: publicProductionStatus(result.status),
          },
  };
}

async function mutationResult(
  request: FastifyRequest,
  operation: () => Promise<{
    readonly status: number;
    readonly body: unknown;
    readonly idempotencyCompleted?: true;
  }>,
) {
  try {
    return await operation();
  } catch (error) {
    const code = safeCode(error);
    if (code === null) throw error;
    if (code.endsWith("_unavailable")) {
      return {
        status: 503,
        body: errorBody(
          request,
          "operations_unavailable",
          "Operational state is unavailable",
        ),
        idempotencyRetryable: true as const,
      };
    }
    return {
      ...mutationErrorResponse(request, code),
      ...(idempotencyWasCompleted(error)
        ? { idempotencyCompleted: true as const }
        : {}),
    };
  }
}

function mutationErrorResponse(request: FastifyRequest, code: string) {
  return {
    status: code.endsWith("_not_found")
      ? 404
      : code.endsWith("_conflict")
        ? 409
        : 400,
    body: errorBody(request, code, "Operation could not be completed"),
  };
}

function idempotencyWasCompleted(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  try {
    return (
      Object.getOwnPropertyDescriptor(error, "idempotencyCompleted")?.value ===
      true
    );
  } catch {
    return false;
  }
}

function operationalError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
) {
  const code = safeCode(error);
  if (code === null || code.endsWith("_unavailable")) {
    return reply
      .code(503)
      .send(
        errorBody(
          request,
          "operations_unavailable",
          "Operational state is unavailable",
        ),
      );
  }
  if (code.endsWith("_not_found")) return notFound(request, reply, code);
  return reply
    .code(code.endsWith("_conflict") ? 409 : 400)
    .send(errorBody(request, code, "Operation could not be completed"));
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

function optionalIncidentState(
  value: unknown,
): OperationalIncidentState | undefined {
  return typeof value === "string" && incidentStates.has(value)
    ? (value as OperationalIncidentState)
    : undefined;
}

function optionalIncidentKind(
  value: unknown,
): OperationalIncidentKind | undefined {
  return typeof value === "string" && incidentKinds.has(value)
    ? (value as OperationalIncidentKind)
    : undefined;
}

function pathId(value: unknown, key: string): string | null {
  if (value === null || typeof value !== "object") return null;
  const id = (value as Record<string, unknown>)[key];
  return typeof id === "string" && uuidPattern.test(id) ? id : null;
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function invalidCursorValue(): never {
  throw Object.assign(new Error("invalid cursor"), { code: "invalid_cursor" });
}

function isCursorFailure(error: unknown): boolean {
  return safeCode(error) === "invalid_cursor";
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

function noStore(reply: FastifyReply): void {
  reply.header("cache-control", "private, no-store");
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
    else if (Array.isArray(value)) {
      for (const entry of value) headers.append(name, entry);
    }
  }
  return headers;
}
