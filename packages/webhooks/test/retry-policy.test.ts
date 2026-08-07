import { describe, expect, it } from "vitest";
import { classifyDeliveryResult, nextAttemptAt } from "../src/index.js";

describe("delivery retry policy", () => {
  it.each([200, 201, 204, 299])("classifies HTTP %i as success", (status) => {
    expect(classifyDeliveryResult({ kind: "response", status })).toBe(
      "success",
    );
  });

  it.each([408, 425, 429, 500, 502, 503, 599])(
    "classifies HTTP %i as retryable",
    (status) => {
      expect(classifyDeliveryResult({ kind: "response", status })).toBe(
        "retry",
      );
    },
  );

  it("classifies network failures as retryable", () => {
    expect(
      classifyDeliveryResult({ kind: "network_error", code: "timeout" }),
    ).toBe("retry");
  });

  it.each([99, 300, 400, 401, 404, 409, 422, 499, 600])(
    "classifies HTTP %i as terminal",
    (status) => {
      expect(classifyDeliveryResult({ kind: "response", status })).toBe("dead");
    },
  );

  it("uses capped exponential delay with deterministic jitter", () => {
    const firstAttemptAt = new Date("2026-08-07T10:00:00.000Z");

    expect(nextAttemptAt(firstAttemptAt, 1, firstAttemptAt, () => 0)).toEqual(
      new Date("2026-08-07T10:00:02.500Z"),
    );
    expect(nextAttemptAt(firstAttemptAt, 2, firstAttemptAt, () => 0.5)).toEqual(
      new Date("2026-08-07T10:00:10.000Z"),
    );
    expect(
      nextAttemptAt(firstAttemptAt, 11, firstAttemptAt, () => 0.999_999),
    ).toEqual(new Date("2026-08-07T11:00:00.000Z"));
  });

  it("honours a valid Retry-After delay without exceeding its bound", () => {
    const firstAttemptAt = new Date("2026-08-07T10:00:00.000Z");
    const now = new Date("2026-08-07T10:01:00.000Z");

    expect(
      nextAttemptAt(firstAttemptAt, 1, now, () => 0.5, {
        retryAfterMs: 45_000,
      }),
    ).toEqual(new Date("2026-08-07T10:01:45.000Z"));
    expect(
      nextAttemptAt(firstAttemptAt, 1, now, () => 0.5, {
        retryAfterMs: 86_400_000,
      }),
    ).toEqual(new Date("2026-08-07T11:01:00.000Z"));
  });

  it("stops at the maximum attempt count", () => {
    const firstAttemptAt = new Date("2026-08-07T10:00:00.000Z");
    expect(
      nextAttemptAt(firstAttemptAt, 12, firstAttemptAt, () => 0.5),
    ).toBeNull();
  });

  it("does not schedule at or beyond the 72-hour retry window", () => {
    const firstAttemptAt = new Date("2026-08-07T10:00:00.000Z");
    expect(
      nextAttemptAt(
        firstAttemptAt,
        1,
        new Date("2026-08-10T10:00:00.000Z"),
        () => 0.5,
      ),
    ).toBeNull();
    expect(
      nextAttemptAt(
        firstAttemptAt,
        11,
        new Date("2026-08-10T09:30:00.000Z"),
        () => 0.999_999,
      ),
    ).toBeNull();
  });

  it("rejects invalid scheduler inputs", () => {
    const now = new Date("2026-08-07T10:00:00.000Z");
    expect(() => nextAttemptAt(now, 0, now, () => 0.5)).toThrow(/attempt/i);
    expect(() => nextAttemptAt(now, 1, now, () => 1)).toThrow(/random/i);
    expect(() =>
      nextAttemptAt(now, 1, now, () => 0.5, { retryAfterMs: -1 }),
    ).toThrow(/retry-after/i);
  });
});
