import type { OrganizationDatabase } from "../db/organization-transaction.js";
import type { IdempotencyActorKind } from "../idempotency/idempotency-store.js";

const routeGroupPattern = /^[a-z][a-z0-9_.-]{0,127}$/;

export interface RateLimitInput {
  readonly organizationId: string;
  readonly actorKind: IdempotencyActorKind;
  readonly actorId: string;
  readonly routeGroup: string;
  readonly now: Date;
}

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  readonly retryAfterSeconds: number;
}

export class RateLimitError extends Error {
  public readonly code: string;

  public constructor(code: string) {
    super("Rate limit operation failed");
    this.name = "RateLimitError";
    this.code = code;
  }
}

export class RateLimitStore {
  readonly #database: OrganizationDatabase;
  readonly #limit: number;
  readonly #windowSeconds: number;

  public constructor(
    database: OrganizationDatabase,
    options: { readonly limit: number; readonly windowSeconds: number },
  ) {
    if (
      !Number.isSafeInteger(options.limit) ||
      options.limit < 1 ||
      options.limit > 10_000 ||
      !Number.isSafeInteger(options.windowSeconds) ||
      options.windowSeconds < 1 ||
      options.windowSeconds > 3_600
    ) {
      throw new RateLimitError("invalid_rate_limit_configuration");
    }
    this.#database = database;
    this.#limit = options.limit;
    this.#windowSeconds = options.windowSeconds;
  }

  public async consume(input: RateLimitInput): Promise<RateLimitResult> {
    if (
      !routeGroupPattern.test(input.routeGroup) ||
      !Number.isFinite(input.now.getTime())
    ) {
      throw new RateLimitError("invalid_rate_limit_input");
    }
    const windowMs = this.#windowSeconds * 1_000;
    const bucketStartedAt = new Date(
      Math.floor(input.now.getTime() / windowMs) * windowMs,
    );
    return this.#database.transaction(
      { organizationId: input.organizationId, actorId: input.actorId },
      async (transaction) => {
        const rows = await transaction<{ request_count: number }[]>`
          INSERT INTO api_rate_limit_buckets (
            organization_id, actor_kind, actor_id, route_group,
            bucket_started_at, request_count, updated_at
          ) VALUES (
            ${input.organizationId}::uuid, ${input.actorKind}, ${input.actorId},
            ${input.routeGroup}, ${bucketStartedAt.toISOString()}, 1,
            ${input.now.toISOString()}
          )
          ON CONFLICT (
            organization_id, actor_kind, actor_id, route_group,
            bucket_started_at
          ) DO UPDATE SET
            request_count = api_rate_limit_buckets.request_count + 1,
            updated_at = EXCLUDED.updated_at
          RETURNING request_count
        `;
        const count = rows[0]!.request_count;
        return {
          allowed: count <= this.#limit,
          limit: this.#limit,
          remaining: Math.max(0, this.#limit - count),
          retryAfterSeconds: Math.max(
            1,
            Math.ceil(
              (bucketStartedAt.getTime() + windowMs - input.now.getTime()) /
                1_000,
            ),
          ),
        };
      },
    );
  }
}
