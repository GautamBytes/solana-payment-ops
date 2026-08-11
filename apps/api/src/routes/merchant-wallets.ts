import {
  type OrganizationPermission,
  type RateLimitStore,
  type WalletProofSubmission,
  WalletStore,
} from "@payops/platform";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type {
  AuthContextResolver,
  RequestActor,
  SessionActor,
} from "../auth/context.js";
import { requireSensitiveSession } from "../auth/context.js";
import { errorBody } from "../protocol/api-error.js";
import { IdempotentRouteExecutor } from "../protocol/idempotent-route.js";
import { requestIdFor } from "../protocol/request-context.js";

const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function registerMerchantWalletRoutes(
  server: FastifyInstance,
  dependencies: {
    readonly auth: AuthContextResolver;
    readonly wallets: WalletStore;
    readonly idempotency: IdempotentRouteExecutor;
    readonly rateLimits: RateLimitStore;
  },
): void {
  server.get("/v1/merchant-wallets", async (request, reply) => {
    const actor = await authenticate(
      request,
      reply,
      dependencies.auth,
      "walletRead",
    );
    if (actor === null) return reply;
    if (
      !(await consumeRateLimit(
        request,
        reply,
        dependencies.rateLimits,
        actor,
        "wallet.read",
      ))
    ) {
      return reply;
    }
    const wallets = await dependencies.wallets.list({
      organizationId: actor.organizationId,
      actorId: actor.actorId,
    });
    return reply.send({ data: wallets });
  });

  server.post("/v1/merchant-wallets/challenges", async (request, reply) => {
    const actor = await owner(request, reply, dependencies.auth, false);
    if (actor === null) return reply;
    if (
      !(await consumeRateLimit(
        request,
        reply,
        dependencies.rateLimits,
        actor,
        "wallet.write",
      ))
    )
      return reply;
    const body = parseObject(request.body, ["address"]);
    if (typeof body.address !== "string") return invalidBody(request, reply);
    try {
      const challenge = await dependencies.wallets.createChallenge({
        organizationId: actor.organizationId,
        actorId: actor.actorId,
        address: body.address,
        now: new Date(),
      });
      return reply.code(201).send(challenge);
    } catch (error) {
      return walletError(request, reply, error);
    }
  });

  server.post("/v1/merchant-wallets", async (request, reply) => {
    const actor = await owner(request, reply, dependencies.auth, false);
    if (actor === null) return reply;
    if (
      !(await consumeRateLimit(
        request,
        reply,
        dependencies.rateLimits,
        actor,
        "wallet.write",
      ))
    )
      return reply;
    if (!actor.twoFactorEnabled) {
      return reply
        .code(403)
        .send(
          errorBody(
            request,
            "two_factor_required",
            "Two-factor authentication is required",
          ),
        );
    }
    const parsed = parseRegistrationBody(request.body);
    if (parsed === null) return invalidBody(request, reply);
    return dependencies.idempotency.execute(
      request,
      reply,
      actor,
      "merchant_wallets.register",
      {},
      parsed,
      async (idempotency) => {
        try {
          const wallet = await dependencies.wallets.register({
            organizationId: actor.organizationId,
            actorId: actor.actorId,
            proof: parsed.proof,
            acceptedAssetSymbols: parsed.acceptedAssetSymbols,
            now: new Date(),
            auditRequestId: requestIdFor(request),
            idempotency,
          });
          return { status: 201, body: wallet, idempotencyCompleted: true };
        } catch (error) {
          return walletResult(request, error);
        }
      },
    );
  });

  server.post(
    "/v1/merchant-wallets/:walletId/replacement-challenges",
    async (request, reply) => {
      const actor = await owner(request, reply, dependencies.auth, true);
      if (actor === null) return reply;
      if (
        !(await consumeRateLimit(
          request,
          reply,
          dependencies.rateLimits,
          actor,
          "wallet.write",
        ))
      )
        return reply;
      const walletId = routeWalletId(request.params);
      const body = parseObject(request.body, ["address"]);
      if (walletId === null || typeof body.address !== "string") {
        return invalidBody(request, reply);
      }
      const wallets = await dependencies.wallets.list({
        organizationId: actor.organizationId,
        actorId: actor.actorId,
      });
      if (
        !wallets.some(
          (wallet) => wallet.id === walletId && wallet.status === "active",
        )
      ) {
        return reply
          .code(404)
          .send(errorBody(request, "wallet_not_found", "Wallet was not found"));
      }
      try {
        const challenge = await dependencies.wallets.createChallenge({
          organizationId: actor.organizationId,
          actorId: actor.actorId,
          address: body.address,
          now: new Date(),
        });
        return reply.code(201).send(challenge);
      } catch (error) {
        return walletError(request, reply, error);
      }
    },
  );

  server.post(
    "/v1/merchant-wallets/:walletId/replace",
    async (request, reply) => {
      const actor = await owner(request, reply, dependencies.auth, true);
      if (actor === null) return reply;
      if (
        !(await consumeRateLimit(
          request,
          reply,
          dependencies.rateLimits,
          actor,
          "wallet.write",
        ))
      )
        return reply;
      const walletId = routeWalletId(request.params);
      const parsed = parseReplacementBody(request.body);
      if (walletId === null || parsed === null)
        return invalidBody(request, reply);
      return dependencies.idempotency.execute(
        request,
        reply,
        actor,
        `merchant_wallets.replace.${parsed.action}`,
        { walletId },
        parsed,
        async (idempotency) => {
          try {
            if (parsed.action === "request") {
              const result = await dependencies.wallets.requestReplacement({
                organizationId: actor.organizationId,
                actorId: actor.actorId,
                walletId,
                proof: parsed.proof,
                acceptedAssetSymbols: parsed.acceptedAssetSymbols,
                now: new Date(),
                auditRequestId: requestIdFor(request),
                idempotency,
              });
              return {
                status: 202,
                body: result,
                idempotencyCompleted: true,
              };
            }
            const wallet = await dependencies.wallets.activateReplacement({
              organizationId: actor.organizationId,
              actorId: actor.actorId,
              walletId,
              proof: parsed.proof,
              now: new Date(),
              auditRequestId: requestIdFor(request),
              idempotency,
            });
            return {
              status: 200,
              body: wallet,
              idempotencyCompleted: true,
            };
          } catch (error) {
            return walletResult(request, error);
          }
        },
      );
    },
  );
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

async function owner(
  request: FastifyRequest,
  reply: FastifyReply,
  auth: AuthContextResolver,
  sensitive: boolean,
): Promise<SessionActor | null> {
  const actor = await authenticate(request, reply, auth, "walletAdmin");
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
  if (sensitive) {
    try {
      return requireSensitiveSession(actor, new Date(), {
        requireTwoFactor: true,
      });
    } catch {
      reply
        .code(403)
        .send(
          errorBody(
            request,
            "fresh_two_factor_required",
            "Fresh two-factor authentication is required",
          ),
        );
      return null;
    }
  }
  return actor;
}

async function consumeRateLimit(
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
  reply.header("x-ratelimit-limit", result.limit);
  reply.header("x-ratelimit-remaining", result.remaining);
  if (result.allowed) return true;
  reply.header("retry-after", result.retryAfterSeconds);
  reply
    .code(429)
    .send(errorBody(request, "rate_limit_exceeded", "Rate limit exceeded"));
  return false;
}

function parseRegistrationBody(value: unknown): {
  readonly proof: WalletProofSubmission;
  readonly acceptedAssetSymbols: readonly string[];
} | null {
  const body = parseObject(value, [
    "challengeId",
    "nonce",
    "signature",
    "acceptedAssetSymbols",
  ]);
  if (
    typeof body.challengeId !== "string" ||
    typeof body.nonce !== "string" ||
    typeof body.signature !== "string" ||
    !Array.isArray(body.acceptedAssetSymbols) ||
    !body.acceptedAssetSymbols.every((symbol) => typeof symbol === "string")
  ) {
    return null;
  }
  return {
    proof: {
      challengeId: body.challengeId,
      nonce: body.nonce,
      signature: body.signature,
    },
    acceptedAssetSymbols: body.acceptedAssetSymbols,
  };
}

function parseReplacementBody(value: unknown):
  | {
      readonly action: "request";
      readonly proof: WalletProofSubmission;
      readonly acceptedAssetSymbols: readonly string[];
    }
  | {
      readonly action: "activate";
      readonly proof: WalletProofSubmission;
    }
  | null {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.action === "request") {
    const registration = parseRegistrationBody({
      challengeId: candidate.challengeId,
      nonce: candidate.nonce,
      signature: candidate.signature,
      acceptedAssetSymbols: candidate.acceptedAssetSymbols,
    });
    if (
      registration === null ||
      Object.keys(candidate).sort().join(",") !==
        "acceptedAssetSymbols,action,challengeId,nonce,signature"
    )
      return null;
    return { action: "request", ...registration };
  }
  if (
    candidate.action === "activate" &&
    Object.keys(candidate).sort().join(",") ===
      "action,challengeId,nonce,signature" &&
    typeof candidate.challengeId === "string" &&
    typeof candidate.nonce === "string" &&
    typeof candidate.signature === "string"
  ) {
    return {
      action: "activate",
      proof: {
        challengeId: candidate.challengeId,
        nonce: candidate.nonce,
        signature: candidate.signature,
      },
    };
  }
  return null;
}

function parseObject(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return {};
  const record = value as Record<string, unknown>;
  return Object.keys(record).sort().join(",") === [...keys].sort().join(",")
    ? record
    : {};
}

function routeWalletId(value: unknown): string | null {
  if (value === null || typeof value !== "object") return null;
  const id = (value as Record<string, unknown>).walletId;
  return typeof id === "string" && canonicalUuidPattern.test(id) ? id : null;
}

function walletResult(
  request: FastifyRequest,
  error: unknown,
): { status: number; body: object } {
  const code = safeWalletCode(error);
  if (
    code === null ||
    code === "solana_rpc_unavailable" ||
    code === "wallet_configuration_unavailable" ||
    code === "wallet_store_unavailable"
  ) {
    throw error;
  }
  const status =
    code === "wallet_not_found"
      ? 404
      : code === "wallet_already_registered"
        ? 409
        : 400;
  return {
    status,
    body: errorBody(request, code, "Wallet operation could not be completed"),
  };
}

function safeWalletCode(error: unknown): string | null {
  if (
    error === null ||
    (typeof error !== "object" && typeof error !== "function")
  ) {
    return null;
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, "code");
    if (
      descriptor !== undefined &&
      "value" in descriptor &&
      typeof descriptor.value === "string" &&
      /^[a-z][a-z0-9_]{0,127}$/.test(descriptor.value)
    ) {
      return descriptor.value;
    }
  } catch {
    return null;
  }
  return null;
}

function walletError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
): FastifyReply {
  const result = walletResult(request, error);
  return reply.code(result.status).send(result.body);
}

function invalidBody(
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
