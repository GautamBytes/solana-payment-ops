import { createHash, randomUUID } from "node:crypto";
import {
  type CheckoutRecord,
  type PublicCheckoutView,
  type PublicPaymentAttempt,
} from "@payops/platform";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AuthContextResolver, RequestActor } from "../auth/context.js";
import { errorBody } from "../protocol/api-error.js";
import { CheckoutTokenKeyring } from "../security/public-token.js";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface CheckoutRoutesStore {
  getActiveForInvoice(input: {
    readonly organizationId: string;
    readonly actorId: string;
    readonly invoiceId: string;
  }): Promise<CheckoutRecord | null>;
  create(input: {
    readonly organizationId: string;
    readonly actorId: string;
    readonly invoiceId: string;
    readonly checkoutId: string;
    readonly publicNonce: Uint8Array;
    readonly derivationKeyId: string;
    readonly tokenDigest: string;
    readonly now: Date;
  }): Promise<CheckoutRecord>;
  resolve(tokenDigest: string, actorId: string): Promise<CheckoutRecord | null>;
  publicView(
    checkout: CheckoutRecord,
    now: Date,
  ): Promise<PublicCheckoutView | null>;
}

interface PaymentAttemptsPort {
  create(input: {
    readonly organizationId: string;
    readonly actorId: string;
    readonly checkoutId: string;
    readonly assetSymbol: "USDC" | "USDT";
    readonly idempotencyKey: string;
    readonly now: Date;
    readonly signal: AbortSignal;
  }): Promise<PublicPaymentAttempt>;
}

interface RateLimitPort {
  consume(input: {
    readonly organizationId: string;
    readonly actorKind: "session" | "api_key";
    readonly actorId: string;
    readonly routeGroup: string;
    readonly now: Date;
  }): Promise<{
    readonly allowed: boolean;
    readonly limit: number;
    readonly remaining: number;
    readonly retryAfterSeconds: number;
  }>;
}

export function registerCheckoutRoutes(
  server: FastifyInstance,
  dependencies: {
    readonly auth: AuthContextResolver;
    readonly checkouts: CheckoutRoutesStore;
    readonly tokens: CheckoutTokenKeyring;
    readonly paymentAttempts: PaymentAttemptsPort;
    readonly rateLimits: RateLimitPort;
    readonly checkoutOrigin: string;
  },
): void {
  server.post(
    "/v1/invoices/:invoiceId/checkout-links",
    async (request, reply) => {
      const actor = await authenticate(request, reply, dependencies.auth);
      if (actor === null) return reply;
      if (!actor.permissions.invoiceIssue)
        return reply.code(403).send(forbidden(request));
      if (
        !(await consumeMerchant(request, reply, dependencies.rateLimits, actor))
      )
        return reply;
      const invoiceId = pathValue(request.params, "invoiceId");
      if (invoiceId === null || !emptyBody(request.body))
        return reply.code(400).send(invalid(request));
      try {
        let checkout = await dependencies.checkouts.getActiveForInvoice({
          organizationId: actor.organizationId,
          actorId: actor.actorId,
          invoiceId,
        });
        if (checkout === null) {
          const checkoutId = randomUUID();
          const material = dependencies.tokens.create(checkoutId);
          try {
            checkout = await dependencies.checkouts.create({
              organizationId: actor.organizationId,
              actorId: actor.actorId,
              invoiceId,
              checkoutId,
              publicNonce: material.publicNonce,
              derivationKeyId: material.keyId,
              tokenDigest: material.digest,
              now: new Date(),
            });
          } catch (error) {
            if (safeCode(error) !== "checkout_already_active") throw error;
            checkout = await dependencies.checkouts.getActiveForInvoice({
              organizationId: actor.organizationId,
              actorId: actor.actorId,
              invoiceId,
            });
            if (checkout === null) throw error;
          }
        }
        const material = dependencies.tokens.derive(
          checkout.checkoutId,
          checkout.publicNonce,
          checkout.derivationKeyId,
        );
        return reply.code(201).send({
          checkoutId: checkout.checkoutId,
          checkoutUrl: `${dependencies.checkoutOrigin}/pay/${material.token}`,
          createdAt: checkout.createdAt,
        });
      } catch (error) {
        const code = safeCode(error);
        if (
          code === "checkout_store_unavailable" ||
          code === "checkout_token_key_unavailable"
        ) {
          return reply
            .code(503)
            .send(
              errorBody(
                request,
                "checkout_unavailable",
                "Checkout is unavailable",
              ),
            );
        }
        return reply
          .code(404)
          .send(
            errorBody(request, "invoice_not_found", "Invoice was not found"),
          );
      }
    },
  );

  server.post(
    "/v1/invoices/:invoiceId/payment-attempts",
    async (request, reply) => {
      const actor = await authenticate(request, reply, dependencies.auth);
      if (actor === null) return reply;
      if (!actor.permissions.invoiceIssue)
        return reply.code(403).send(forbidden(request));
      if (
        !(await consumeMerchant(request, reply, dependencies.rateLimits, actor))
      )
        return reply;
      const invoiceId = pathValue(request.params, "invoiceId");
      const body = record(request.body);
      const idempotencyKey = requestIdempotencyKey(request);
      if (
        invoiceId === null ||
        body === null ||
        Object.keys(body).join(",") !== "assetSymbol" ||
        (body.assetSymbol !== "USDC" && body.assetSymbol !== "USDT")
      ) {
        return reply.code(400).send(invalid(request));
      }
      if (idempotencyKey === null) {
        return reply.code(400).send(invalidIdempotencyKey(request));
      }
      const checkout = await dependencies.checkouts.getActiveForInvoice({
        organizationId: actor.organizationId,
        actorId: actor.actorId,
        invoiceId,
      });
      if (checkout === null) {
        return reply
          .code(404)
          .send(
            errorBody(request, "checkout_not_found", "Checkout was not found"),
          );
      }
      try {
        const attempt = await dependencies.paymentAttempts.create({
          organizationId: actor.organizationId,
          actorId: actor.actorId,
          checkoutId: checkout.checkoutId,
          assetSymbol: body.assetSymbol,
          idempotencyKey,
          now: new Date(),
          signal: AbortSignal.timeout(30_000),
        });
        return reply.code(201).send(attempt);
      } catch (error) {
        const code = safeCode(error);
        const conflict = isAttemptConflict(code);
        return reply
          .code(conflict ? 409 : 503)
          .send(
            errorBody(
              request,
              conflict ? "payment_attempt_already_active" : "quote_unavailable",
              conflict
                ? "A payment attempt is already active"
                : "A safe quote is not currently available",
            ),
          );
      }
    },
  );

  server.options("/pay/:checkoutToken", async (request, reply) =>
    publicPreflight(request, reply, dependencies.checkoutOrigin),
  );
  server.options("/pay/:checkoutToken/quotes", async (request, reply) =>
    publicPreflight(request, reply, dependencies.checkoutOrigin),
  );
  server.options("/pay/:checkoutToken/status", async (request, reply) =>
    publicPreflight(request, reply, dependencies.checkoutOrigin),
  );

  server.get("/pay/:checkoutToken", async (request, reply) => {
    securePublicReply(request, reply, dependencies.checkoutOrigin);
    const resolved = await resolvePublic(request, dependencies);
    if (resolved === null) return publicNotFound(request, reply);
    if (
      !(await consumePublic(request, reply, dependencies.rateLimits, resolved))
    )
      return reply;
    const view = await dependencies.checkouts.publicView(
      resolved.checkout,
      new Date(),
    );
    return view === null ? publicNotFound(request, reply) : reply.send(view);
  });

  server.post("/pay/:checkoutToken/quotes", async (request, reply) => {
    securePublicReply(request, reply, dependencies.checkoutOrigin);
    if (request.headers.origin !== dependencies.checkoutOrigin) {
      return reply.code(403).send(forbidden(request));
    }
    const resolved = await resolvePublic(request, dependencies);
    if (resolved === null) return publicNotFound(request, reply);
    if (
      !(await consumePublic(request, reply, dependencies.rateLimits, resolved))
    )
      return reply;
    const body = record(request.body);
    const idempotencyKey = requestIdempotencyKey(request);
    if (
      body === null ||
      Object.keys(body).join(",") !== "assetSymbol" ||
      (body.assetSymbol !== "USDC" && body.assetSymbol !== "USDT")
    ) {
      return reply.code(400).send(invalid(request));
    }
    if (idempotencyKey === null) {
      return reply.code(400).send(invalidIdempotencyKey(request));
    }
    try {
      const attempt = await dependencies.paymentAttempts.create({
        organizationId: resolved.checkout.organizationId,
        actorId: "public-checkout",
        checkoutId: resolved.checkout.checkoutId,
        assetSymbol: body.assetSymbol,
        idempotencyKey,
        now: new Date(),
        signal: AbortSignal.timeout(30_000),
      });
      return reply.code(201).send(attempt);
    } catch (error) {
      const code = safeCode(error);
      const conflict = isAttemptConflict(code);
      return reply
        .code(conflict ? 409 : 503)
        .send(
          errorBody(
            request,
            conflict ? "payment_attempt_already_active" : "quote_unavailable",
            conflict
              ? "A payment attempt is already active"
              : "A safe quote is not currently available",
          ),
        );
    }
  });

  server.get("/pay/:checkoutToken/status", async (request, reply) => {
    securePublicReply(request, reply, dependencies.checkoutOrigin);
    const resolved = await resolvePublic(request, dependencies);
    if (resolved === null) return publicNotFound(request, reply);
    if (
      !(await consumePublic(request, reply, dependencies.rateLimits, resolved))
    )
      return reply;
    const view = await dependencies.checkouts.publicView(
      resolved.checkout,
      new Date(),
    );
    if (view === null) return publicNotFound(request, reply);
    const body = {
      invoiceStatus: view.invoice.status,
      currentAttempt: view.currentAttempt,
    };
    const etag = `"${createHash("sha256").update(JSON.stringify(body)).digest("base64url")}"`;
    reply.header("etag", etag);
    if (request.headers["if-none-match"] === etag)
      return reply.code(304).send();
    return reply.send(body);
  });
}

async function resolvePublic(
  request: FastifyRequest,
  dependencies: {
    readonly checkouts: CheckoutRoutesStore;
    readonly tokens: CheckoutTokenKeyring;
  },
) {
  const token = pathValue(request.params, "checkoutToken", false);
  if (token === null) return null;
  try {
    const digest = dependencies.tokens.digestToken(token);
    const checkout = await dependencies.checkouts.resolve(
      digest,
      "public-checkout",
    );
    return checkout === null ? null : { checkout, digest };
  } catch {
    return null;
  }
}

function requestIdempotencyKey(request: FastifyRequest): string | null {
  const value = request.headers["idempotency-key"];
  return typeof value === "string" && /^[\x21-\x7e]{16,128}$/.test(value)
    ? value
    : null;
}

function invalidIdempotencyKey(request: FastifyRequest) {
  return errorBody(
    request,
    "invalid_idempotency_key",
    "A valid Idempotency-Key is required",
  );
}

function isAttemptConflict(code: string | null): boolean {
  return (
    code === "payment_attempt_already_active" ||
    code === "payment_attempt_idempotency_conflict"
  );
}

async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply,
  auth: AuthContextResolver,
): Promise<RequestActor | null> {
  try {
    return await auth.resolve(new Headers(toHeaderEntries(request.headers)));
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

async function consumeMerchant(
  request: FastifyRequest,
  reply: FastifyReply,
  rateLimits: RateLimitPort,
  actor: RequestActor,
): Promise<boolean> {
  const result = await rateLimits.consume({
    organizationId: actor.organizationId,
    actorKind: actor.kind,
    actorId: actor.actorId,
    routeGroup: "checkout-link.write",
    now: new Date(),
  });
  return applyRateLimit(request, reply, result);
}

async function consumePublic(
  request: FastifyRequest,
  reply: FastifyReply,
  rateLimits: RateLimitPort,
  resolved: NonNullable<Awaited<ReturnType<typeof resolvePublic>>>,
): Promise<boolean> {
  const actorId = `public:${createHash("sha256")
    .update(resolved.digest)
    .update("\n")
    .update(request.ip)
    .digest("hex")}`;
  const result = await rateLimits.consume({
    organizationId: resolved.checkout.organizationId,
    actorKind: "api_key",
    actorId,
    routeGroup: "public-checkout",
    now: new Date(),
  });
  return applyRateLimit(request, reply, result);
}

function applyRateLimit(
  request: FastifyRequest,
  reply: FastifyReply,
  result: Awaited<ReturnType<RateLimitPort["consume"]>>,
): boolean {
  reply.header("x-ratelimit-limit", result.limit);
  reply.header("x-ratelimit-remaining", result.remaining);
  if (result.allowed) return true;
  reply.header("retry-after", result.retryAfterSeconds);
  reply
    .code(429)
    .send(errorBody(request, "rate_limit_exceeded", "Rate limit exceeded"));
  return false;
}

function securePublicReply(
  request: FastifyRequest,
  reply: FastifyReply,
  checkoutOrigin: string,
): void {
  reply.header("cache-control", "private, no-store");
  reply.header("referrer-policy", "no-referrer");
  reply.header("x-robots-tag", "noindex, nofollow, noarchive");
  reply.header("x-content-type-options", "nosniff");
  reply.header(
    "content-security-policy",
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  );
  if (request.headers.origin === checkoutOrigin) {
    reply.header("access-control-allow-origin", checkoutOrigin);
    reply.header("vary", "origin");
  }
}

function publicPreflight(
  request: FastifyRequest,
  reply: FastifyReply,
  checkoutOrigin: string,
) {
  securePublicReply(request, reply, checkoutOrigin);
  if (request.headers.origin !== checkoutOrigin)
    return reply.code(403).send(forbidden(request));
  return reply
    .header("access-control-allow-methods", "GET, POST, OPTIONS")
    .header("access-control-allow-headers", "content-type, if-none-match")
    .code(204)
    .send();
}

function publicNotFound(request: FastifyRequest, reply: FastifyReply) {
  return reply
    .code(404)
    .send(errorBody(request, "checkout_not_found", "Checkout was not found"));
}

function invalid(request: FastifyRequest) {
  return errorBody(request, "invalid_request", "Request body is invalid");
}

function forbidden(request: FastifyRequest) {
  return errorBody(request, "forbidden", "Permission is required");
}

function pathValue(
  value: unknown,
  key: string,
  requireUuid = true,
): string | null {
  const params = record(value);
  const candidate = params?.[key];
  if (typeof candidate !== "string" || candidate.length > 128) return null;
  return !requireUuid || uuidPattern.test(candidate) ? candidate : null;
}

function emptyBody(value: unknown): boolean {
  const body = record(value);
  return body !== null && Object.keys(body).length === 0;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
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
      typeof descriptor.value === "string"
      ? descriptor.value
      : null;
  } catch {
    return null;
  }
}

function toHeaderEntries(
  headers: FastifyRequest["headers"],
): [string, string][] {
  return Object.entries(headers).flatMap(([key, value]) =>
    value === undefined
      ? []
      : [[key, Array.isArray(value) ? value.join(", ") : String(value)]],
  );
}
