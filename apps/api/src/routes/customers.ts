import {
  CustomerStore,
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

export function registerCustomerRoutes(
  server: FastifyInstance,
  dependencies: {
    readonly auth: AuthContextResolver;
    readonly customers: CustomerStore;
    readonly idempotency: IdempotentRouteExecutor;
    readonly rateLimits: RateLimitStore;
  },
): void {
  server.post("/v1/customers", async (request, reply) => {
    const actor = await authenticate(
      request,
      reply,
      dependencies.auth,
      "customerWrite",
    );
    if (actor === null) return reply;
    if (
      !(await consume(
        request,
        reply,
        dependencies.rateLimits,
        actor,
        "customer.write",
      ))
    ) {
      return reply;
    }
    const body = parseCreateBody(request.body);
    if (body === null) return invalidRequest(request, reply);
    return dependencies.idempotency.execute(
      request,
      reply,
      actor,
      "customers.create",
      {},
      body,
      async (idempotency) => {
        try {
          const customer = await dependencies.customers.create({
            organizationId: actor.organizationId,
            actorKind: actor.kind,
            actorId: actor.actorId,
            ...body,
            now: new Date(),
            auditRequestId: requestIdFor(request),
            idempotency,
          });
          return { status: 201, body: customer, idempotencyCompleted: true };
        } catch (error) {
          const code = safeCode(error);
          if (
            code === null ||
            code === "customer_store_unavailable" ||
            code === "corrupt_customer" ||
            (code !== "customer_external_id_conflict" &&
              !code.startsWith("invalid_customer"))
          ) {
            throw error;
          }
          return {
            status: code === "customer_external_id_conflict" ? 409 : 400,
            body: errorBody(request, code, "Customer could not be created"),
          };
        }
      },
    );
  });

  server.get("/v1/customers", async (request, reply) => {
    const actor = await authenticate(
      request,
      reply,
      dependencies.auth,
      "customerRead",
    );
    if (actor === null) return reply;
    if (
      !(await consume(
        request,
        reply,
        dependencies.rateLimits,
        actor,
        "customer.read",
      ))
    )
      return reply;
    const query = queryRecord(request.query);
    let limit: number;
    const filterDigest = cursorFilterDigest({
      endpoint: "customers.list",
      organizationId: actor.organizationId,
      sort: "created_desc",
      filters: {},
    });
    let after: { readonly createdAt: string; readonly id: string } | undefined;
    try {
      if (!onlyKeys(query, ["limit", "cursor"]))
        throw new Error("unknown query");
      limit = parseLimit(query.limit);
      if (query.cursor !== undefined) {
        if (typeof query.cursor !== "string") throw new Error("invalid cursor");
        after = decodeCursor(query.cursor, filterDigest);
      }
    } catch {
      return reply
        .code(400)
        .send(errorBody(request, "invalid_cursor", "List cursor is invalid"));
    }
    const rows = await dependencies.customers.list({
      organizationId: actor.organizationId,
      actorId: actor.actorId,
      limit: limit + 1,
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
  });

  server.get("/v1/customers/:customerId", async (request, reply) => {
    const actor = await authenticate(
      request,
      reply,
      dependencies.auth,
      "customerRead",
    );
    if (actor === null) return reply;
    if (
      !(await consume(
        request,
        reply,
        dependencies.rateLimits,
        actor,
        "customer.read",
      ))
    )
      return reply;
    const customerId = pathId(request.params, "customerId");
    if (customerId === null) {
      return reply
        .code(404)
        .send(
          errorBody(request, "customer_not_found", "Customer was not found"),
        );
    }
    const customer = await dependencies.customers.get({
      organizationId: actor.organizationId,
      actorId: actor.actorId,
      customerId,
    });
    if (customer === null) {
      return reply
        .code(404)
        .send(
          errorBody(request, "customer_not_found", "Customer was not found"),
        );
    }
    return reply.send(customer);
  });
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

function parseCreateBody(value: unknown): {
  readonly externalId?: string | null;
  readonly displayName: string;
  readonly email?: string | null;
  readonly metadata?: Readonly<Record<string, string>>;
} | null {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return null;
  const body = value as Record<string, unknown>;
  if (
    !onlyKeys(body, ["externalId", "displayName", "email", "metadata"]) ||
    typeof body.displayName !== "string" ||
    (body.externalId !== undefined &&
      body.externalId !== null &&
      typeof body.externalId !== "string") ||
    (body.email !== undefined &&
      body.email !== null &&
      typeof body.email !== "string") ||
    (body.metadata !== undefined &&
      (body.metadata === null ||
        typeof body.metadata !== "object" ||
        Array.isArray(body.metadata)))
  )
    return null;
  return {
    displayName: body.displayName,
    ...(body.externalId === undefined
      ? {}
      : { externalId: body.externalId as string | null }),
    ...(body.email === undefined ? {} : { email: body.email as string | null }),
    ...(body.metadata === undefined
      ? {}
      : { metadata: body.metadata as Readonly<Record<string, string>> }),
  };
}

function queryRecord(value: unknown): Record<string, unknown> {
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

function pathId(value: unknown, key: string): string | null {
  if (value === null || typeof value !== "object") return null;
  const id = (value as Record<string, unknown>)[key];
  return typeof id === "string" && canonicalUuidPattern.test(id) ? id : null;
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

function toHeaders(request: FastifyRequest): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === "string") headers.append(name, value);
    else if (Array.isArray(value))
      for (const entry of value) headers.append(name, entry);
  }
  return headers;
}
