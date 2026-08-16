import { createHmac } from "node:crypto";

import {
  preparePublicWalletAnalysisRequest,
  PublicWalletRequestError,
  type PublicWalletAnalysis,
  type PublicWalletAnalysisInput,
  type PublicWalletRequestField,
  type SolanaRpcPort,
} from "@payops/ingestion";
import {
  type PublicAnalysisRateLimitInput,
  type PublicAnalysisRateLimitResult,
} from "@payops/platform";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { ApiError } from "../protocol/api-error.js";

interface PublicWalletAnalysisRouteDependencies {
  readonly trustedOrigins: readonly string[];
  readonly clientDigestSecret: string;
  readonly rateLimits: {
    consume(
      input: PublicAnalysisRateLimitInput,
    ): Promise<PublicAnalysisRateLimitResult>;
  };
  readonly rpcForRequest: (signal: AbortSignal) => SolanaRpcPort;
  readonly analyze: (
    input: PublicWalletAnalysisInput,
    dependencies: {
      readonly rpc: SolanaRpcPort;
      readonly maxSignatures: number;
      readonly maxTransactions: number;
      readonly concurrency: number;
    },
  ) => Promise<PublicWalletAnalysis>;
  readonly now?: () => Date;
}

export function registerPublicWalletAnalysisRoutes(
  server: FastifyInstance,
  dependencies: PublicWalletAnalysisRouteDependencies,
): void {
  server.options("/v1/public/wallet-analysis", async (request, reply) => {
    const origin = requireTrustedOrigin(request, dependencies.trustedOrigins);
    setCorsHeaders(reply, origin);
    reply.header("access-control-allow-methods", "POST");
    reply.header("access-control-allow-headers", "content-type");
    return reply.code(204).send();
  });

  server.post("/v1/public/wallet-analysis", async (request, reply) => {
    const origin = requireTrustedOrigin(request, dependencies.trustedOrigins);
    setCorsHeaders(reply, origin);

    const now = dependencies.now?.() ?? new Date();
    let prepared: Awaited<
      ReturnType<typeof preparePublicWalletAnalysisRequest>
    >;
    try {
      prepared = await preparePublicWalletAnalysisRequest(request.body, now);
    } catch (error) {
      if (error instanceof PublicWalletRequestError) {
        throw invalidRequest(error.field);
      }
      throw invalidRequest("walletAddress");
    }

    const clientDigest = createHmac(
      "sha256",
      Buffer.from(dependencies.clientDigestSecret, "base64url"),
    )
      .update(request.ip)
      .digest("hex");
    let rateLimit: PublicAnalysisRateLimitResult;
    try {
      rateLimit = await dependencies.rateLimits.consume({ clientDigest, now });
    } catch {
      throw unavailable();
    }
    reply.header("x-ratelimit-limit", rateLimit.limit);
    reply.header("x-ratelimit-remaining", rateLimit.remaining);
    if (!rateLimit.allowed) {
      reply.header("retry-after", rateLimit.retryAfterSeconds);
      throw new ApiError(
        429,
        "public_analysis_rate_limited",
        "Too many public analyses",
      );
    }

    try {
      const signal = AbortSignal.timeout(20_000);
      return await dependencies.analyze(prepared.input, {
        rpc: dependencies.rpcForRequest(signal),
        maxSignatures: 200,
        maxTransactions: 100,
        concurrency: 4,
      });
    } catch {
      throw unavailable();
    }
  });
}

function setCorsHeaders(reply: FastifyReply, origin: string): void {
  reply.header("access-control-allow-origin", origin);
  reply.header("access-control-expose-headers", "retry-after");
  reply.header("vary", "Origin");
  reply.header("cache-control", "no-store");
}

function requireTrustedOrigin(
  request: FastifyRequest,
  trustedOrigins: readonly string[],
): string {
  const origin = request.headers.origin;
  if (typeof origin !== "string" || !trustedOrigins.includes(origin)) {
    throw new ApiError(403, "untrusted_origin", "Origin is not trusted");
  }
  return origin;
}

function invalidRequest(field: PublicWalletRequestField): ApiError {
  return new ApiError(
    400,
    "invalid_public_analysis_request",
    "Public analysis request is invalid",
    { field },
  );
}

function unavailable(): ApiError {
  return new ApiError(
    503,
    "public_analysis_unavailable",
    "Public analysis is temporarily unavailable",
  );
}
