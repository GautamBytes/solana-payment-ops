import {
  acceptBootstrapInvitation,
  CheckoutStore,
  CommercialFiatRateAdapter,
  EcbReferenceRateAdapter,
  HttpSolanaAccountRpcPort,
  CustomerStore,
  IdempotencyStore,
  InvoiceStore,
  OrganizationDatabase,
  PaymentAttemptService,
  PythHermesPriceAdapter,
  RateLimitStore,
  type SolanaAccountRpcPort,
  type EmailDeliveryPort,
  WalletStore,
} from "@payops/platform";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { createPayOpsAuth, hashAuthPassword } from "./auth/better-auth.js";
import { createAuthContextResolver } from "./auth/context.js";
import type { ApiConfig } from "./config.js";
import { installErrorHandler } from "./protocol/api-error.js";
import { errorBody } from "./protocol/api-error.js";
import { installRequestContext } from "./protocol/request-context.js";
import { IdempotentRouteExecutor } from "./protocol/idempotent-route.js";
import { registerMerchantWalletRoutes } from "./routes/merchant-wallets.js";
import { registerCustomerRoutes } from "./routes/customers.js";
import { registerInvoiceRoutes } from "./routes/invoices.js";
import { registerCheckoutRoutes } from "./routes/public-checkout.js";
import { CheckoutTokenKeyring } from "./security/public-token.js";

export interface ApiServerDependencies {
  readonly emailDelivery: EmailDeliveryPort;
  readonly solanaRpc?: SolanaAccountRpcPort;
}

export function buildApiServer(
  config: ApiConfig,
  dependencies: ApiServerDependencies,
): FastifyInstance {
  const server = Fastify({
    logger: false,
    bodyLimit: 256 * 1_024,
    requestTimeout: 30_000,
  });
  installRequestContext(server);
  installErrorHandler(server);
  server.addHook("preHandler", async (request, reply) => {
    if (
      request.url.startsWith("/v1/") &&
      request.method !== "GET" &&
      request.method !== "HEAD" &&
      request.method !== "OPTIONS" &&
      request.headers.cookie !== undefined &&
      !hasTrustedOrigin(request, config.trustedOrigins)
    ) {
      return reply
        .code(403)
        .send(errorBody(request, "untrusted_origin", "Origin is not trusted"));
    }
  });
  const auth = createPayOpsAuth(config, dependencies.emailDelivery);
  const authContext = createAuthContextResolver(auth.auth, config.databaseUrl);
  const platformDatabase = new OrganizationDatabase(config.databaseUrl);
  const solanaRpc =
    dependencies.solanaRpc ??
    new HttpSolanaAccountRpcPort({ endpoint: config.solanaRpcUrl });
  const walletStore = new WalletStore({
    database: platformDatabase,
    proofDomain: config.walletProofDomain,
    providerId: config.ingestionProviderId,
    rpc: solanaRpc,
  });
  const idempotency = new IdempotentRouteExecutor(
    new IdempotencyStore(platformDatabase),
    platformDatabase,
  );
  const rateLimits = new RateLimitStore(platformDatabase, {
    limit: config.rateLimitMax,
    windowSeconds: config.rateLimitWindowSeconds,
  });
  const checkoutStore = new CheckoutStore(platformDatabase, config.databaseUrl);
  const checkoutTokens = new CheckoutTokenKeyring(config.checkoutTokenKeys);
  const paymentAttempts = new PaymentAttemptService({
    database: platformDatabase,
    providerId: config.ingestionProviderId,
    environment: config.environment === "production" ? "production" : "test",
    stablecoinPrices: new PythHermesPriceAdapter({
      endpoint: config.pythHermesEndpoint,
      accessToken: config.pythAccessToken,
      feeds: config.pythFeedIds,
    }),
    fiatRates:
      config.commercialFx === undefined
        ? new EcbReferenceRateAdapter({ endpoint: config.ecbEndpoint })
        : new CommercialFiatRateAdapter(config.commercialFx),
    quoteHead: {
      getFinalizedHead: async () => solanaRpc.getFinalizedHead(),
    },
  });

  server.route({
    method: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    url: "/api/auth/*",
    handler: async (request, reply) => {
      const webRequest = toWebRequest(request, config.publicApiOrigin);
      const response = await auth.handler(webRequest);
      return sendWebResponse(reply, response);
    },
  });

  server.post("/v1/auth/bootstrap/accept", async (request, reply) => {
    if (!hasTrustedOrigin(request, config.trustedOrigins)) {
      return reply.code(403).send({
        ...errorBody(
          request,
          "untrusted_origin",
          "Request origin is not trusted",
        ),
      });
    }
    let body: ReturnType<typeof parseBootstrapBody>;
    try {
      body = parseBootstrapBody(request.body);
    } catch {
      return reply.code(400).send({
        ...errorBody(request, "invalid_request", "Request body is invalid"),
      });
    }
    const passwordLength = [...body.password].length;
    if (passwordLength < 12 || passwordLength > 128) {
      return reply.code(400).send({
        ...errorBody(
          request,
          "invalid_password",
          "Password does not meet policy",
        ),
      });
    }
    try {
      const accepted = await acceptBootstrapInvitation(
        {
          token: body.token,
          email: body.email,
          name: body.name,
          passwordHash: await hashAuthPassword(body.password),
          now: new Date(),
        },
        { databaseUrl: config.databaseUrl },
      );
      await auth.auth.api.sendVerificationEmail({
        body: { email: accepted.email, callbackURL: "/" },
      });
      return reply.code(201).send(accepted);
    } catch {
      return reply.code(400).send({
        ...errorBody(
          request,
          "invalid_bootstrap_invitation",
          "Invitation cannot be accepted",
        ),
      });
    }
  });

  server.get("/v1/organization", async (request, reply) => {
    try {
      const actor = await authContext.resolve(toHeaders(request));
      if (!actor.permissions.organizationRead) {
        return reply
          .code(403)
          .send(errorBody(request, "forbidden", "Permission is required"));
      }
      const rateLimit = await rateLimits.consume({
        organizationId: actor.organizationId,
        actorKind: actor.kind,
        actorId: actor.actorId,
        routeGroup: "organization.read",
        now: new Date(),
      });
      reply.header("x-ratelimit-limit", rateLimit.limit);
      reply.header("x-ratelimit-remaining", rateLimit.remaining);
      if (!rateLimit.allowed) {
        reply.header("retry-after", rateLimit.retryAfterSeconds);
        return reply
          .code(429)
          .send(
            errorBody(request, "rate_limit_exceeded", "Rate limit exceeded"),
          );
      }
      return reply.send({
        organizationId: actor.organizationId,
        actorKind: actor.kind,
        permissions: actor.permissions,
      });
    } catch {
      return reply.code(401).send({
        ...errorBody(
          request,
          "authentication_required",
          "Authentication is required",
        ),
      });
    }
  });

  server.get("/health/live", async () => ({ status: "ok" }));
  server.get("/health/ready", async (_request, reply) => {
    try {
      await platformDatabase.healthCheck();
      return reply.send({ status: "ok" });
    } catch {
      return reply.code(503).send({ status: "unavailable" });
    }
  });

  registerMerchantWalletRoutes(server, {
    auth: authContext,
    wallets: walletStore,
    idempotency,
    rateLimits,
  });
  registerCustomerRoutes(server, {
    auth: authContext,
    customers: new CustomerStore(platformDatabase),
    idempotency,
    rateLimits,
  });
  registerInvoiceRoutes(server, {
    auth: authContext,
    invoices: new InvoiceStore(platformDatabase),
    idempotency,
    rateLimits,
  });
  registerCheckoutRoutes(server, {
    auth: authContext,
    checkouts: checkoutStore,
    tokens: checkoutTokens,
    paymentAttempts,
    rateLimits,
    checkoutOrigin: config.checkoutOrigin,
  });

  server.addHook("onClose", async () => {
    await Promise.all([
      auth.close(),
      authContext.close(),
      checkoutStore.close(),
      platformDatabase.close(),
    ]);
  });
  return server;
}

function parseBootstrapBody(value: unknown): {
  readonly token: string;
  readonly email: string;
  readonly name: string;
  readonly password: string;
} {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid_bootstrap_body");
  }
  const body = value as Record<string, unknown>;
  if (
    Object.keys(body).sort().join(",") !== "email,name,password,token" ||
    typeof body.token !== "string" ||
    typeof body.email !== "string" ||
    typeof body.name !== "string" ||
    typeof body.password !== "string"
  ) {
    throw new Error("invalid_bootstrap_body");
  }
  return {
    token: body.token,
    email: body.email,
    name: body.name,
    password: body.password,
  };
}

function hasTrustedOrigin(
  request: FastifyRequest,
  trustedOrigins: readonly string[],
): boolean {
  const origin = request.headers.origin;
  return typeof origin === "string" && trustedOrigins.includes(origin);
}

function toWebRequest(request: FastifyRequest, publicOrigin: string): Request {
  const method = request.method.toUpperCase();
  const headers = toHeaders(request);
  const body =
    method === "GET" || method === "HEAD" || request.body === undefined
      ? undefined
      : typeof request.body === "string"
        ? request.body
        : Buffer.isBuffer(request.body)
          ? request.body.toString("utf8")
          : JSON.stringify(request.body);
  return new Request(new URL(request.raw.url ?? request.url, publicOrigin), {
    method,
    headers,
    ...(body === undefined ? {} : { body }),
  });
}

function toHeaders(request: FastifyRequest): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (name === "content-length" || name === "transfer-encoding") continue;
    if (typeof value === "string") headers.append(name, value);
    else if (Array.isArray(value)) {
      for (const entry of value) headers.append(name, entry);
    }
  }
  return headers;
}

async function sendWebResponse(
  reply: FastifyReply,
  response: Response,
): Promise<FastifyReply> {
  response.headers.forEach((value, name) => {
    if (name !== "set-cookie" && name !== "content-length") {
      reply.header(name, value);
    }
  });
  const headers = response.headers as Headers & {
    getSetCookie?: () => string[];
  };
  const setCookies = headers.getSetCookie?.() ?? [];
  if (setCookies.length > 0) reply.header("set-cookie", setCookies);
  else {
    const setCookie = response.headers.get("set-cookie");
    if (setCookie !== null) reply.header("set-cookie", setCookie);
  }
  const body = Buffer.from(await response.arrayBuffer());
  return reply.code(response.status).send(body.length === 0 ? null : body);
}
