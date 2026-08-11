import { createHash } from "node:crypto";
import { canonicalJson } from "@payops/platform";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const digestPattern = /^[0-9a-f]{64}$/;

export interface CursorPosition {
  readonly createdAt: string;
  readonly id: string;
}

export class CursorError extends Error {
  public readonly code = "invalid_cursor";

  public constructor() {
    super("Cursor is invalid for this list");
    this.name = "CursorError";
  }
}

export function cursorFilterDigest(value: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

export function encodeCursor(
  position: CursorPosition,
  filterDigest: string,
): string {
  validatePosition(position);
  if (!digestPattern.test(filterDigest)) throw new CursorError();
  return Buffer.from(
    canonicalJson({
      v: 1,
      createdAt: position.createdAt,
      id: position.id,
      filterDigest,
    }),
    "utf8",
  ).toString("base64url");
}

export function decodeCursor(
  value: string,
  expectedFilterDigest: string,
): CursorPosition {
  if (
    value.length < 16 ||
    value.length > 1_024 ||
    !/^[A-Za-z0-9_-]+$/.test(value) ||
    !digestPattern.test(expectedFilterDigest)
  ) {
    throw new CursorError();
  }
  let parsed: unknown;
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.byteLength > 768 || bytes.toString("base64url") !== value) {
      throw new CursorError();
    }
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new CursorError();
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CursorError();
  }
  const record = parsed as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !== "createdAt,filterDigest,id,v" ||
    record.v !== 1 ||
    typeof record.createdAt !== "string" ||
    typeof record.id !== "string" ||
    record.filterDigest !== expectedFilterDigest
  ) {
    throw new CursorError();
  }
  const position = { createdAt: record.createdAt, id: record.id };
  validatePosition(position);
  return position;
}

export function parseLimit(value: unknown, fallback = 50): number {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^[1-9]\d{0,2}$/.test(value)) {
    throw new CursorError();
  }
  const limit = Number(value);
  if (limit < 1 || limit > 100) throw new CursorError();
  return limit;
}

function validatePosition(position: CursorPosition): void {
  if (
    !uuidPattern.test(position.id) ||
    !timestampPattern.test(position.createdAt) ||
    !Number.isFinite(new Date(position.createdAt).getTime())
  ) {
    throw new CursorError();
  }
}
