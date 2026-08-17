import { createHmac } from "node:crypto";
import type {
  PublicAnalysisRateLimitInput,
  PublicAnalysisRateLimitResult,
} from "@payops/platform";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { errorBody } from "../protocol/api-error.js";

interface BootstrapAcceptance {
  readonly email: string;
}

interface BootstrapAcceptanceInput {
  readonly token: string;
  readonly email: string;
  readonly name: string;
  readonly passwordHash: string;
  readonly now: Date;
}

export interface BootstrapAcceptanceDependencies {
  readonly trustedOrigins: readonly string[];
  readonly clientDigestSecret: string;
  readonly rateLimits: {
    consume(
      input: PublicAnalysisRateLimitInput,
    ): Promise<PublicAnalysisRateLimitResult>;
  };
  readonly hashPassword: (password: string) => Promise<string>;
  readonly acceptInvitation: (
    input: BootstrapAcceptanceInput,
  ) => Promise<BootstrapAcceptance>;
  readonly sendVerificationEmail: (email: string) => Promise<void>;
}

export function registerBootstrapAcceptanceRoute(
  server: FastifyInstance,
  dependencies: BootstrapAcceptanceDependencies,
): void {
  server.post("/v1/auth/bootstrap/accept", async (request, reply) => {
    if (!hasTrustedOrigin(request, dependencies.trustedOrigins)) {
      return reply.code(403).send({
        ...errorBody(
          request,
          "untrusted_origin",
          "Request origin is not trusted",
        ),
      });
    }

    if (!(await consumeRateLimit(request, reply, dependencies))) return reply;

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
      const accepted = await dependencies.acceptInvitation({
        token: body.token,
        email: body.email,
        name: body.name,
        passwordHash: await dependencies.hashPassword(body.password),
        now: new Date(),
      });
      await dependencies.sendVerificationEmail(accepted.email);
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
}

async function consumeRateLimit(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: BootstrapAcceptanceDependencies,
): Promise<boolean> {
  const clientDigest = createHmac(
    "sha256",
    Buffer.from(dependencies.clientDigestSecret, "base64url"),
  )
    .update(request.ip)
    .digest("hex");
  let result: PublicAnalysisRateLimitResult;
  try {
    result = await dependencies.rateLimits.consume({
      clientDigest,
      now: new Date(),
    });
  } catch {
    reply
      .code(503)
      .send(
        errorBody(
          request,
          "bootstrap_rate_limit_unavailable",
          "Bootstrap acceptance is temporarily unavailable",
        ),
      );
    return false;
  }
  reply.header("x-ratelimit-limit", result.limit);
  reply.header("x-ratelimit-remaining", result.remaining);
  if (result.allowed) return true;
  reply.header("retry-after", result.retryAfterSeconds);
  reply
    .code(429)
    .send(errorBody(request, "rate_limit_exceeded", "Rate limit exceeded"));
  return false;
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
