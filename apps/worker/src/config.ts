import {
  parseRpcProviderConfiguration,
  WORKER_JOB_NAMES,
  type DeploymentEnvironment,
  type RpcProviderConfiguration,
  type WorkerJobName,
} from "@payops/platform";

export interface WorkerJobConfig {
  readonly name: WorkerJobName;
  readonly intervalMs: number;
  readonly batchSize: number;
  readonly concurrency: number;
  readonly leaseMs: number;
}

export interface WorkerConfig {
  readonly databaseUrl: string;
  readonly shadowProjectorDatabaseUrl: string;
  readonly parserVersion: string;
  readonly buildRevision: string;
  readonly rpc: RpcProviderConfiguration;
  readonly jobs: readonly WorkerJobConfig[];
}

export function parseWorkerConfig(
  environment: NodeJS.ProcessEnv,
): WorkerConfig {
  const databaseUrl = required(environment, "DATABASE_URL");
  const shadowProjectorDatabaseUrl = required(
    environment,
    "PAYOPS_SHADOW_PROJECTOR_DATABASE_URL",
  );
  try {
    new URL(databaseUrl);
    new URL(shadowProjectorDatabaseUrl);
  } catch {
    throw configError("invalid_database_url");
  }
  const deploymentEnvironment = required(environment, "PAYOPS_ENVIRONMENT");
  if (!isDeploymentEnvironment(deploymentEnvironment)) {
    throw configError("invalid_environment");
  }
  let rpc: RpcProviderConfiguration;
  try {
    rpc = parseRpcProviderConfiguration(environment, deploymentEnvironment);
  } catch {
    throw configError("invalid_rpc_configuration");
  }
  const parserVersion = own(environment, "PAYOPS_PARSER_VERSION") ?? "0.2.0";
  if (
    !/^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/.test(
      parserVersion,
    )
  ) {
    throw configError("invalid_parser_version");
  }
  const buildRevision =
    own(environment, "PAYOPS_BUILD_REVISION") ?? "development";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(buildRevision)) {
    throw configError("invalid_build_revision");
  }
  const intervalMs = boundedInteger(
    own(environment, "PAYOPS_WORKER_INTERVAL_MS"),
    2_000,
    250,
    60_000,
  );
  const batchSize = boundedInteger(
    own(environment, "PAYOPS_WORKER_BATCH_SIZE"),
    50,
    1,
    100,
  );
  const concurrency = boundedInteger(
    own(environment, "PAYOPS_WORKER_CONCURRENCY"),
    4,
    1,
    16,
  );
  const leaseMs = boundedInteger(
    own(environment, "PAYOPS_WORKER_LEASE_MS"),
    30_000,
    5_000,
    120_000,
  );
  return Object.freeze({
    databaseUrl,
    shadowProjectorDatabaseUrl,
    parserVersion,
    buildRevision,
    rpc,
    jobs: Object.freeze(
      WORKER_JOB_NAMES.map((name) =>
        Object.freeze({ name, intervalMs, batchSize, concurrency, leaseMs }),
      ),
    ),
  });
}

function own(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  return Object.hasOwn(environment, name) ? environment[name] : undefined;
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = own(environment, name);
  if (typeof value !== "string" || value.length === 0) {
    throw configError("missing_configuration");
  }
  return value;
}

function isDeploymentEnvironment(
  value: string,
): value is DeploymentEnvironment {
  return ["local", "test", "production"].includes(value);
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
