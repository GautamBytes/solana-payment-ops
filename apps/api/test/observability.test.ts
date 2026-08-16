import { describe, expect, test } from "vitest";
import {
  apiLoggerOptions,
  safeDurationMs,
  safeStatusClass,
} from "../src/observability/logger.js";

describe("API observability", () => {
  test("disables logs in tests and enables redacted JSON logs in production", () => {
    expect(apiLoggerOptions("test")).toBe(false);
    expect(apiLoggerOptions("production")).toMatchObject({
      level: "info",
      redact: {
        censor: "[REDACTED]",
      },
    });
  });

  test.each([
    [200, "2xx"],
    [429, "4xx"],
    [503, "5xx"],
    [99, "unknown"],
    [600, "unknown"],
  ])("maps status %i to %s", (status, expected) => {
    expect(safeStatusClass(status)).toBe(expected);
  });

  test.each([
    [-1, 0],
    [12.6, 13],
    [Number.POSITIVE_INFINITY, 0],
    [4_000_000, 3_600_000],
  ])("bounds duration %s to %i", (duration, expected) => {
    expect(safeDurationMs(duration)).toBe(expected);
  });

  test("redacts every sensitive field that Fastify or a future log call may attach", () => {
    const options = apiLoggerOptions("production");
    expect(options).not.toBe(false);
    if (options === false) return;
    expect(options.redact.paths).toEqual(
      expect.arrayContaining([
        "req.headers",
        "request.headers",
        "request.body",
        "response.body",
        "wallet",
        "walletAddress",
        "signature",
        "authorization",
        "cookie",
      ]),
    );
  });
});
