import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PayOpsEnvironment } from "../config.js";
import { requestIdFor } from "../protocol/request-context.js";

const maximumRecordedDurationMs = 60 * 60 * 1_000;
const startedAt = new WeakMap<FastifyRequest, number>();

export function apiLoggerOptions(environment: PayOpsEnvironment) {
  if (environment === "test") return false as const;
  return {
    level: environment === "production" ? "info" : "debug",
    redact: {
      paths: [
        "req.headers",
        "req.body",
        "request.headers",
        "request.body",
        "response.body",
        "headers",
        "body",
        "wallet",
        "walletAddress",
        "signature",
        "authorization",
        "cookie",
      ],
      censor: "[REDACTED]",
    },
  };
}

export function safeStatusClass(statusCode: number): string {
  if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) {
    return "unknown";
  }
  return `${Math.floor(statusCode / 100)}xx`;
}

export function safeDurationMs(durationMs: number): number {
  if (!Number.isFinite(durationMs)) return 0;
  return Math.min(
    maximumRecordedDurationMs,
    Math.max(0, Math.round(durationMs)),
  );
}

export function installApiRequestLogging(server: FastifyInstance): void {
  server.addHook("onRequest", async (request) => {
    startedAt.set(request, performance.now());
  });
  server.addHook("onResponse", async (request, reply) => {
    const start = startedAt.get(request) ?? performance.now();
    request.log.info({
      event: "api_request_completed",
      requestId: requestIdFor(request),
      method: request.method,
      route: request.routeOptions.url,
      statusClass: safeStatusClass(reply.statusCode),
      durationMs: safeDurationMs(performance.now() - start),
    });
  });
}
