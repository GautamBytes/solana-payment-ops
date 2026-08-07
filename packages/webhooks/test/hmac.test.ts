import { describe, expect, it } from "vitest";
import { signWebhook, verifyWebhook } from "../src/index.js";

const body = '{"ok":true}';
const timestamp = "1786060800";
const now = new Date(1_786_060_800_000);
const toleranceMs = 300_000;

describe("signWebhook", () => {
  it("produces the v1 HMAC-SHA256 vector", () => {
    expect(signWebhook(body, timestamp, "test-secret")).toBe(
      "v1=3d2a166be8ab5872681fa38b5207c424c9b57e875e8cc51682a07b3fa3216862",
    );
  });
});

describe("verifyWebhook", () => {
  it("accepts the current signing secret", () => {
    const signature = signWebhook(body, timestamp, "current-secret");

    expect(
      verifyWebhook(
        { body, timestamp, signature },
        ["current-secret", "previous-secret"],
        now,
        toleranceMs,
      ),
    ).toEqual({ ok: true, secretIndex: 0 });
  });

  it("accepts the previous signing secret during rotation", () => {
    const signature = signWebhook(body, timestamp, "previous-secret");

    expect(
      verifyWebhook(
        { body, timestamp, signature },
        ["current-secret", "previous-secret"],
        now,
        toleranceMs,
      ),
    ).toEqual({ ok: true, secretIndex: 1 });
  });

  it.each([
    [
      "not-a-number",
      "v1=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "malformed_timestamp",
    ],
    [timestamp, "v1=not-hex", "malformed_signature"],
    [
      timestamp,
      "v2=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "unsupported_signature_version",
    ],
  ] as const)("rejects %s with %s", (requestTimestamp, signature, code) => {
    expect(
      verifyWebhook(
        { body, timestamp: requestTimestamp, signature },
        ["test-secret"],
        now,
        toleranceMs,
      ),
    ).toEqual({ ok: false, code });
  });

  it("rejects timestamps outside the tolerance window", () => {
    expect(
      verifyWebhook(
        {
          body,
          timestamp: String(1_786_060_800 - 301),
          signature:
            "v1=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        },
        ["test-secret"],
        now,
        toleranceMs,
      ),
    ).toEqual({ ok: false, code: "timestamp_outside_tolerance" });
  });

  it("uses a five-minute tolerance when none is provided", () => {
    const staleTimestamp = String(1_786_060_800 - 301);
    const signature = signWebhook(body, staleTimestamp, "test-secret");

    expect(
      verifyWebhook(
        { body, timestamp: staleTimestamp, signature },
        ["test-secret"],
        now,
      ),
    ).toEqual({ ok: false, code: "timestamp_outside_tolerance" });
  });

  it.each([
    ["invalid current time", new Date(Number.NaN), toleranceMs],
    ["NaN tolerance", now, Number.NaN],
    ["infinite tolerance", now, Number.POSITIVE_INFINITY],
    ["negative tolerance", now, -1],
    ["tolerance above one hour", now, 3_600_001],
  ] as const)("fails closed for %s", (_name, verificationNow, tolerance) => {
    const staleTimestamp = String(1_786_060_800 - 86_400);
    const signature = signWebhook(body, staleTimestamp, "test-secret");

    expect(
      verifyWebhook(
        { body, timestamp: staleTimestamp, signature },
        ["test-secret"],
        verificationNow,
        tolerance,
      ),
    ).toEqual({ ok: false, code: "invalid_verification_options" });
  });

  it("accepts the documented one-hour maximum tolerance", () => {
    const withinMaximum = String(1_786_060_800 - 3_600);
    const signature = signWebhook(body, withinMaximum, "test-secret");

    expect(
      verifyWebhook(
        { body, timestamp: withinMaximum, signature },
        ["test-secret"],
        now,
        3_600_000,
      ),
    ).toEqual({ ok: true, secretIndex: 0 });
  });

  it("rejects altered body bytes with an equal-length digest", () => {
    const signature = signWebhook(body, timestamp, "test-secret");

    expect(
      verifyWebhook(
        { body: '{"ok":false}', timestamp, signature },
        ["test-secret"],
        now,
        toleranceMs,
      ),
    ).toEqual({ ok: false, code: "signature_mismatch" });
  });
});
