import { WORKER_JOB_NAMES, type WorkerJobName } from "@payops/platform";

export interface WorkerJobConfig {
  readonly name: WorkerJobName;
  readonly intervalMs: number;
  readonly batchSize: number;
  readonly concurrency: number;
  readonly leaseMs: number;
}

export interface WorkerConfig {
  readonly databaseUrl: string;
  readonly parserVersion: string;
  readonly jobs: readonly WorkerJobConfig[];
}

export function parseWorkerConfig(
  environment: NodeJS.ProcessEnv,
): WorkerConfig {
  const databaseUrl = required(environment, "DATABASE_URL");
  try {
    new URL(databaseUrl);
  } catch {
    throw configError("invalid_database_url");
  }
  const parserVersion = environment.PAYOPS_PARSER_VERSION ?? "0.2.0";
  if (
    !/^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/.test(
      parserVersion,
    )
  ) {
    throw configError("invalid_parser_version");
  }
  const intervalMs = boundedInteger(
    environment.PAYOPS_WORKER_INTERVAL_MS,
    2_000,
    250,
    60_000,
  );
  const batchSize = boundedInteger(
    environment.PAYOPS_WORKER_BATCH_SIZE,
    50,
    1,
    100,
  );
  const concurrency = boundedInteger(
    environment.PAYOPS_WORKER_CONCURRENCY,
    4,
    1,
    16,
  );
  const leaseMs = boundedInteger(
    environment.PAYOPS_WORKER_LEASE_MS,
    30_000,
    5_000,
    120_000,
  );
  return Object.freeze({
    databaseUrl,
    parserVersion,
    jobs: Object.freeze(
      WORKER_JOB_NAMES.map((name) =>
        Object.freeze({ name, intervalMs, batchSize, concurrency, leaseMs }),
      ),
    ),
  });
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = Object.hasOwn(environment, name)
    ? environment[name]
    : undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw configError("missing_configuration");
  }
  return value;
}

function boundedInteger(
  value: string | undefined,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return defaultValue;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw configError("invalid_worker_bounds");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw configError("invalid_worker_bounds");
  }
  return parsed;
}

function configError(code: string): Error & { readonly code: string } {
  return Object.assign(new Error("Worker configuration is invalid"), { code });
}
