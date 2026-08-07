import { createHmac, timingSafeEqual } from "node:crypto";
import type { VerificationResult, WebhookRequest } from "../domain/types.js";

const signaturePattern = /^([a-z0-9]+)=([0-9a-f]+)$/;
const unixTimestampPattern = /^(0|[1-9][0-9]*)$/;
const maximumToleranceMs = 3_600_000;

export function signWebhook(
  body: string,
  timestamp: string,
  secret: string,
): string {
  const digest = createHmac("sha256", secret)
    .update(timestamp + "." + body, "utf8")
    .digest("hex");
  return "v1=" + digest;
}

export function verifyWebhook(
  request: WebhookRequest,
  secrets: readonly string[],
  now: Date,
  toleranceMs = 300_000,
): VerificationResult {
  if (
    !Number.isFinite(now.getTime()) ||
    !Number.isFinite(toleranceMs) ||
    toleranceMs < 0 ||
    toleranceMs > maximumToleranceMs
  ) {
    return { ok: false, code: "invalid_verification_options" };
  }
  const timestamp = parseUnixTimestamp(request.timestamp);
  if (timestamp === undefined) {
    return { ok: false, code: "malformed_timestamp" };
  }

  const signature = parseSignature(request.signature);
  if (signature === "unsupported") {
    return { ok: false, code: "unsupported_signature_version" };
  }
  if (signature === undefined) {
    return { ok: false, code: "malformed_signature" };
  }

  if (Math.abs(now.getTime() - timestamp) > toleranceMs) {
    return { ok: false, code: "timestamp_outside_tolerance" };
  }

  for (const [secretIndex, secret] of secrets.entries()) {
    const expected = signWebhook(request.body, request.timestamp, secret).slice(
      3,
    );
    if (expected.length !== signature.length) continue;

    if (
      timingSafeEqual(
        Buffer.from(expected, "hex"),
        Buffer.from(signature, "hex"),
      )
    ) {
      return { ok: true, secretIndex };
    }
  }

  return { ok: false, code: "signature_mismatch" };
}

function parseUnixTimestamp(value: string): number | undefined {
  if (!unixTimestampPattern.test(value)) return undefined;

  const seconds = Number(value);
  const milliseconds = seconds * 1_000;
  return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
}

function parseSignature(value: string): string | "unsupported" | undefined {
  const match = signaturePattern.exec(value);
  if (match === null) return undefined;

  const [, version, digest] = match;
  if (version === undefined || digest === undefined) return undefined;
  if (version !== "v1") return "unsupported";
  return digest.length === 64 ? digest : undefined;
}
