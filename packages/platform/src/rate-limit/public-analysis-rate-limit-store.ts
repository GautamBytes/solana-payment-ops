import { createHash } from "node:crypto";

import postgres from "postgres";

const digestPattern = /^[0-9a-f]{64}$/;
const namespacePattern = /^[a-z][a-z0-9-]{0,63}$/;

export interface PublicAnalysisRateLimitInput {
  readonly clientDigest: string;
  readonly now: Date;
}

export interface PublicAnalysisRateLimitResult {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  readonly retryAfterSeconds: number;
}

export class PublicAnalysisRateLimitError extends Error {
  public constructor(readonly code: string) {
    super("Public analysis rate-limit operation failed");
    this.name = "PublicAnalysisRateLimitError";
  }
}

export class PublicAnalysisRateLimitStore {
  readonly #sql: postgres.Sql;
  readonly #clientLimit: number;
  readonly #globalLimit: number;
  readonly #windowSeconds: number;
  readonly #namespace: string;
  #closePromise: Promise<void> | undefined;

  public constructor(
    databaseUrl: string,
    options: {
      readonly clientLimit: number;
      readonly globalLimit: number;
      readonly windowSeconds: number;
      readonly namespace?: string;
    },
  ) {
    const namespace = options.namespace ?? "public-analysis";
    if (
      !Number.isSafeInteger(options.clientLimit) ||
      options.clientLimit < 1 ||
      options.clientLimit > 10_000 ||
      !Number.isSafeInteger(options.globalLimit) ||
      options.globalLimit < options.clientLimit ||
      options.globalLimit > 1_000_000 ||
      !Number.isSafeInteger(options.windowSeconds) ||
      options.windowSeconds < 1 ||
      options.windowSeconds > 3_600 ||
      !namespacePattern.test(namespace)
    ) {
      throw new PublicAnalysisRateLimitError(
        "invalid_public_analysis_rate_limit_configuration",
      );
    }
    this.#sql = postgres(databaseUrl, { max: 2, onnotice: () => undefined });
    this.#clientLimit = options.clientLimit;
    this.#globalLimit = options.globalLimit;
    this.#windowSeconds = options.windowSeconds;
    this.#namespace = namespace;
  }

  public async consume(
    input: PublicAnalysisRateLimitInput,
  ): Promise<PublicAnalysisRateLimitResult> {
    if (
      !digestPattern.test(input.clientDigest) ||
      !Number.isFinite(input.now.getTime())
    ) {
      throw new PublicAnalysisRateLimitError(
        "invalid_public_analysis_rate_limit_input",
      );
    }
    const windowMs = this.#windowSeconds * 1_000;
    const bucketStartedAt = new Date(
      Math.floor(input.now.getTime() / windowMs) * windowMs,
    );
    const clientScope = digest(
      `${this.#namespace}:client:${input.clientDigest}`,
    );
    const globalScope = digest(`${this.#namespace}:global`);

    const counts = await this.#sql.begin(async (transaction) => {
      const clientCount = await increment(
        transaction,
        clientScope,
        bucketStartedAt,
        input.now,
      );
      const globalCount = await increment(
        transaction,
        globalScope,
        bucketStartedAt,
        input.now,
      );
      return { clientCount, globalCount };
    });

    return {
      allowed:
        counts.clientCount <= this.#clientLimit &&
        counts.globalCount <= this.#globalLimit,
      limit: this.#clientLimit,
      remaining: Math.max(0, this.#clientLimit - counts.clientCount),
      retryAfterSeconds: Math.max(
        1,
        Math.ceil(
          (bucketStartedAt.getTime() + windowMs - input.now.getTime()) / 1_000,
        ),
      ),
    };
  }

  public close(): Promise<void> {
    this.#closePromise ??= this.#sql.end();
    return this.#closePromise;
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function increment(
  sql: postgres.TransactionSql,
  scopeDigest: string,
  bucketStartedAt: Date,
  now: Date,
): Promise<number> {
  const rows = await sql<{ request_count: number }[]>`
    INSERT INTO public_analysis_rate_limit_buckets (
      scope_digest, bucket_started_at, request_count, updated_at
    ) VALUES (
      ${scopeDigest}, ${bucketStartedAt.toISOString()}, 1, ${now.toISOString()}
    )
    ON CONFLICT (scope_digest, bucket_started_at)
    DO UPDATE SET
      request_count = public_analysis_rate_limit_buckets.request_count + 1,
      updated_at = EXCLUDED.updated_at
    RETURNING request_count
  `;
  return rows[0]!.request_count;
}
