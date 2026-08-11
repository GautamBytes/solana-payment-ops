import { createHash, randomUUID } from "node:crypto";
import type {
  OrganizationDatabase,
  OrganizationTransaction,
} from "../db/organization-transaction.js";

const keyPattern = /^[\x21-\x7e]{16,128}$/;
const routePattern = /^[a-z][a-z0-9_.-]{0,127}$/;
const digestPattern = /^[0-9a-f]{64}$/;
const contentTypePattern = /^[\x20-\x7e]{1,128}$/;

export type IdempotencyActorKind = "session" | "api_key";

export interface IdempotencyIdentity {
  readonly organizationId: string;
  readonly actorKind: IdempotencyActorKind;
  readonly actorId: string;
  readonly routeId: string;
  readonly key: string;
  readonly requestDigest: string;
}

export type IdempotencyClaim =
  | {
      readonly kind: "execute";
      readonly recordId: string;
      readonly leaseToken: string;
    }
  | {
      readonly kind: "replay";
      readonly status: number;
      readonly contentType: string;
      readonly body: Uint8Array;
    }
  | { readonly kind: "conflict" }
  | { readonly kind: "in_progress" };

export interface IdempotencyCompletion {
  readonly organizationId: string;
  readonly recordId: string;
  readonly leaseToken: string;
  readonly status: number;
  readonly contentType: string;
  readonly body: Uint8Array;
  readonly completedAt: Date;
}

export interface IdempotencyResponseCommitter {
  complete(
    transaction: OrganizationTransaction,
    status: number,
    body: unknown,
  ): Promise<void>;
}

export class IdempotencyError extends Error {
  public readonly code: string;

  public constructor(code: string) {
    super("Idempotency operation failed");
    this.name = "IdempotencyError";
    this.code = code;
  }
}

export class IdempotencyStore {
  readonly #database: OrganizationDatabase;
  readonly #leaseMs: number;

  public constructor(
    database: OrganizationDatabase,
    options: { readonly leaseMs?: number } = {},
  ) {
    this.#database = database;
    this.#leaseMs = options.leaseMs ?? 30_000;
    if (
      !Number.isSafeInteger(this.#leaseMs) ||
      this.#leaseMs < 1_000 ||
      this.#leaseMs > 300_000
    ) {
      throw new IdempotencyError("invalid_idempotency_configuration");
    }
  }

  public async claim(
    input: IdempotencyIdentity,
    now: Date,
  ): Promise<IdempotencyClaim> {
    validateIdentity(input);
    assertDate(now);
    return this.#database.transaction(
      { organizationId: input.organizationId, actorId: input.actorId },
      async (transaction) => {
        const lockIdentity = [
          input.organizationId,
          input.actorKind,
          input.actorId,
          input.routeId,
          input.key,
        ].join(":");
        await transaction`
          SELECT pg_advisory_xact_lock(hashtextextended(${lockIdentity}, 0))
        `;
        const rows = await transaction<
          {
            id: string;
            request_digest: string;
            state: "in_progress" | "completed";
            lease_expires_at: Date;
            response_status: number | null;
            response_content_type: string | null;
            response_body: Uint8Array | null;
          }[]
        >`
          SELECT id::text, request_digest, state, lease_expires_at,
            response_status, response_content_type, response_body
          FROM api_idempotency_records
          WHERE organization_id = ${input.organizationId}::uuid
            AND actor_kind = ${input.actorKind}
            AND actor_id = ${input.actorId}
            AND route_id = ${input.routeId}
            AND idempotency_key = ${input.key}
          FOR UPDATE
        `;
        const existing = rows[0];
        if (existing !== undefined) {
          if (existing.request_digest !== input.requestDigest)
            return { kind: "conflict" };
          if (existing.state === "completed") {
            if (
              existing.response_status === null ||
              existing.response_content_type === null ||
              existing.response_body === null
            ) {
              throw new IdempotencyError("corrupt_idempotency_record");
            }
            return {
              kind: "replay",
              status: existing.response_status,
              contentType: existing.response_content_type,
              body: new Uint8Array(existing.response_body),
            };
          }
          if (existing.lease_expires_at.getTime() > now.getTime()) {
            return { kind: "in_progress" };
          }
          const leaseToken = randomUUID();
          const leaseExpiresAt = new Date(now.getTime() + this.#leaseMs);
          await transaction`
            UPDATE api_idempotency_records SET
              lease_token = ${leaseToken}::uuid,
              lease_expires_at = ${leaseExpiresAt.toISOString()},
              updated_at = ${now.toISOString()}
            WHERE id = ${existing.id}::uuid
          `;
          return { kind: "execute", recordId: existing.id, leaseToken };
        }

        const recordId = randomUUID();
        const leaseToken = randomUUID();
        await transaction`
          INSERT INTO api_idempotency_records (
            id, organization_id, actor_kind, actor_id, route_id,
            idempotency_key, request_digest, state, lease_token,
            lease_expires_at, created_at, updated_at
          ) VALUES (
            ${recordId}::uuid, ${input.organizationId}::uuid, ${input.actorKind},
            ${input.actorId}, ${input.routeId}, ${input.key},
            ${input.requestDigest}, 'in_progress', ${leaseToken}::uuid,
            ${new Date(now.getTime() + this.#leaseMs).toISOString()},
            ${now.toISOString()}, ${now.toISOString()}
          )
        `;
        return { kind: "execute", recordId, leaseToken };
      },
    );
  }
}

export async function completeIdempotency(
  transaction: OrganizationTransaction,
  completion: IdempotencyCompletion,
): Promise<void> {
  assertDate(completion.completedAt);
  if (
    !Number.isSafeInteger(completion.status) ||
    completion.status < 100 ||
    completion.status > 599 ||
    !contentTypePattern.test(completion.contentType) ||
    completion.body.byteLength > 1_048_576
  ) {
    throw new IdempotencyError("invalid_idempotency_response");
  }
  const updated = await transaction<{ id: string }[]>`
    UPDATE api_idempotency_records SET
      state = 'completed',
      response_status = ${completion.status},
      response_content_type = ${completion.contentType},
      response_body = ${completion.body},
      completed_at = ${completion.completedAt.toISOString()},
      updated_at = ${completion.completedAt.toISOString()}
    WHERE id = ${completion.recordId}::uuid
      AND organization_id = ${completion.organizationId}::uuid
      AND state = 'in_progress'
      AND lease_token = ${completion.leaseToken}::uuid
    RETURNING id::text
  `;
  if (updated.length !== 1) {
    throw new IdempotencyError("stale_idempotency_lease");
  }
}

export function digestIdempotentRequest(input: {
  readonly method: string;
  readonly routeId: string;
  readonly path: Readonly<Record<string, string>>;
  readonly body: unknown;
}): string {
  return createHash("sha256")
    .update(canonicalJson(input), "utf8")
    .digest("hex");
}

export function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new IdempotencyError("invalid_canonical_json");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  throw new IdempotencyError("invalid_canonical_json");
}

function validateIdentity(input: IdempotencyIdentity): void {
  if (
    !keyPattern.test(input.key) ||
    !routePattern.test(input.routeId) ||
    !digestPattern.test(input.requestDigest) ||
    ![...input.actorId].length ||
    [...input.actorId].length > 128
  ) {
    throw new IdempotencyError("invalid_idempotency_identity");
  }
}

function assertDate(value: Date): void {
  if (!Number.isFinite(value.getTime()))
    throw new IdempotencyError("invalid_idempotency_time");
}
