import { createHmac } from "node:crypto";

import type {
  PublicWalletAnalysis,
  PublicWalletAnalysisInput,
  SolanaRpcPort,
} from "@payops/ingestion";
import {
  ASSET_SYMBOLS,
  assetBySymbol,
  associatedTokenAddress,
  canonicalSolanaAddress,
  type PublicAnalysisRateLimitInput,
  type PublicAnalysisRateLimitResult,
} from "@payops/platform";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { ApiError } from "../protocol/api-error.js";

interface PublicWalletAnalysisRequest {
  readonly walletAddress: string;
  readonly rangeDays: 7 | 30;
  readonly expectation?: {
    readonly assetSymbol?: "USDC" | "USDT";
    readonly amountTokens?: string;
    readonly recipient?: string;
    readonly reference?: string;
  };
}

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

const amountPattern = /^(0|[1-9][0-9]{0,17})(\.[0-9]{1,6})?$/;
const dayMs = 86_400_000;
type RequestField =
  | "walletAddress"
  | "rangeDays"
  | "assetSymbol"
  | "amountTokens"
  | "recipient"
  | "reference";

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

    let body: PublicWalletAnalysisRequest;
    let prepared: Awaited<ReturnType<typeof prepareAnalysisInput>>;
    try {
      body = parseRequestBody(request.body);
      prepared = await prepareAnalysisInput(body);
    } catch (error) {
      if (error instanceof RequestFieldError) {
        throw invalidRequest(error.field);
      }
      throw invalidRequest("walletAddress");
    }

    const now = dependencies.now?.() ?? new Date();
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
      return await dependencies.analyze(
        {
          walletAddress: body.walletAddress,
          watchedTokenAccounts: prepared.watchedTokenAccounts,
          fromTime: new Date(now.getTime() - body.rangeDays * dayMs),
          throughTime: now,
          ...(prepared.expectation === undefined
            ? {}
            : { expectation: prepared.expectation }),
        },
        {
          rpc: dependencies.rpcForRequest(signal),
          maxSignatures: 200,
          maxTransactions: 100,
          concurrency: 4,
        },
      );
    } catch {
      throw unavailable();
    }
  });
}

function setCorsHeaders(reply: FastifyReply, origin: string): void {
  reply.header("access-control-allow-origin", origin);
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

function parseRequestBody(value: unknown): PublicWalletAnalysisRequest {
  const body = record(value, "walletAddress");
  exactKeys(body, ["walletAddress", "rangeDays", "expectation"]);
  if (typeof body.walletAddress !== "string") {
    throw new RequestFieldError("walletAddress");
  }
  let walletAddress: string;
  try {
    walletAddress = canonicalSolanaAddress(body.walletAddress);
  } catch {
    throw new RequestFieldError("walletAddress");
  }
  if (body.rangeDays !== 7 && body.rangeDays !== 30) {
    throw new RequestFieldError("rangeDays");
  }
  if (body.expectation === undefined) {
    return { walletAddress, rangeDays: body.rangeDays };
  }

  const rawExpectation = record(body.expectation, "assetSymbol");
  exactKeys(rawExpectation, [
    "assetSymbol",
    "amountTokens",
    "recipient",
    "reference",
  ]);
  const expectation: {
    assetSymbol?: "USDC" | "USDT";
    amountTokens?: string;
    recipient?: string;
    reference?: string;
  } = {};
  if (rawExpectation.assetSymbol !== undefined) {
    if (
      typeof rawExpectation.assetSymbol !== "string" ||
      !ASSET_SYMBOLS.includes(
        rawExpectation.assetSymbol as (typeof ASSET_SYMBOLS)[number],
      )
    ) {
      throw new RequestFieldError("assetSymbol");
    }
    expectation.assetSymbol = rawExpectation.assetSymbol as "USDC" | "USDT";
  }
  if (rawExpectation.amountTokens !== undefined) {
    if (
      typeof rawExpectation.amountTokens !== "string" ||
      !amountPattern.test(rawExpectation.amountTokens)
    ) {
      throw new RequestFieldError("amountTokens");
    }
    expectation.amountTokens = rawExpectation.amountTokens;
  }
  if (rawExpectation.recipient !== undefined) {
    if (
      typeof rawExpectation.recipient !== "string" ||
      expectation.assetSymbol === undefined
    ) {
      throw new RequestFieldError("recipient");
    }
    try {
      expectation.recipient = canonicalSolanaAddress(rawExpectation.recipient);
    } catch {
      throw new RequestFieldError("recipient");
    }
  }
  if (rawExpectation.reference !== undefined) {
    if (typeof rawExpectation.reference !== "string") {
      throw new RequestFieldError("reference");
    }
    try {
      expectation.reference = canonicalSolanaAddress(rawExpectation.reference);
    } catch {
      throw new RequestFieldError("reference");
    }
  }
  return { walletAddress, rangeDays: body.rangeDays, expectation };
}

async function prepareAnalysisInput(body: PublicWalletAnalysisRequest) {
  const watchedTokenAccounts = await Promise.all(
    ASSET_SYMBOLS.map(async (assetSymbol) => ({
      assetSymbol,
      address: await associatedTokenAddress(
        body.walletAddress,
        assetBySymbol(assetSymbol),
      ),
    })),
  );
  const expectation = body.expectation;
  if (expectation === undefined) {
    return { watchedTokenAccounts };
  }
  return {
    watchedTokenAccounts,
    expectation: {
      ...(expectation.assetSymbol === undefined
        ? {}
        : { assetSymbol: expectation.assetSymbol }),
      ...(expectation.amountTokens === undefined
        ? {}
        : { amountBaseUnits: toBaseUnits(expectation.amountTokens) }),
      ...(expectation.recipient === undefined ||
      expectation.assetSymbol === undefined
        ? {}
        : {
            destinationTokenAccount: await associatedTokenAddress(
              expectation.recipient,
              assetBySymbol(expectation.assetSymbol),
            ),
          }),
      ...(expectation.reference === undefined
        ? {}
        : { reference: expectation.reference }),
    },
  };
}

function toBaseUnits(amountTokens: string): string {
  const [integer = "0", fraction = ""] = amountTokens.split(".");
  return BigInt(`${integer}${fraction.padEnd(6, "0")}`).toString();
}

function record(value: unknown, field: RequestField): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RequestFieldError(field);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const extra = Object.keys(value).find((key) => !allowed.includes(key));
  if (extra !== undefined) throw new RequestFieldError("walletAddress");
}

class RequestFieldError extends Error {
  public constructor(readonly field: RequestField) {
    super("Invalid public analysis request field");
  }
}

function invalidRequest(field: RequestFieldError["field"]): ApiError {
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
