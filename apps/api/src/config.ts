export type PayOpsEnvironment = "local" | "test" | "production";

export interface ApiConfig {
  readonly databaseUrl: string;
  readonly environment: PayOpsEnvironment;
  readonly publicApiOrigin: string;
  readonly trustedOrigins: readonly string[];
  readonly walletProofDomain: string;
  readonly solanaCluster: "mainnet-beta";
  readonly solanaRpcUrl: string;
  readonly ingestionProviderId: string;
  readonly authSecrets: readonly string[];
  readonly emailDeliveryMode: "test" | "production";
  readonly rateLimitMax: number;
  readonly rateLimitWindowSeconds: number;
}

export class ConfigError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "ConfigError";
    this.code = code;
  }
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new ConfigError("missing_configuration");
  }
  return value;
}

function exactOrigin(value: string, allowHttp: boolean): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError("invalid_trusted_origin");
  }
  if (
    url.origin !== value ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    value.includes("*") ||
    (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:"))
  ) {
    throw new ConfigError("invalid_trusted_origin");
  }
  return url.origin;
}

function parseSecrets(value: string): readonly string[] {
  const secrets = value.split(",");
  if (
    secrets.length === 0 ||
    secrets.some(
      (secret) =>
        secret.length < 43 ||
        !/^[A-Za-z0-9_-]+$/.test(secret) ||
        Buffer.from(secret, "base64url").byteLength < 32 ||
        Buffer.from(secret, "base64url").toString("base64url") !== secret,
    )
  ) {
    throw new ConfigError("invalid_auth_secret");
  }
  if (new Set(secrets).size !== secrets.length) {
    throw new ConfigError("duplicate_auth_secret");
  }
  return Object.freeze([...secrets]);
}

export function parseApiConfig(environment: NodeJS.ProcessEnv): ApiConfig {
  const rawEnvironment = required(environment, "PAYOPS_ENVIRONMENT");
  if (
    !(["local", "test", "production"] as const).includes(
      rawEnvironment as PayOpsEnvironment,
    )
  ) {
    throw new ConfigError("invalid_environment");
  }
  const deploymentEnvironment = rawEnvironment as PayOpsEnvironment;
  const allowHttp = deploymentEnvironment !== "production";

  const rawPublicOrigin = required(environment, "PAYOPS_PUBLIC_API_ORIGIN");
  let publicApiOrigin: string;
  try {
    publicApiOrigin = exactOrigin(rawPublicOrigin, allowHttp);
  } catch {
    throw new ConfigError(
      deploymentEnvironment === "production"
        ? "unsafe_api_origin"
        : "invalid_api_origin",
    );
  }

  const trustedOrigins = required(environment, "PAYOPS_TRUSTED_ORIGINS")
    .split(",")
    .map((origin) => exactOrigin(origin, allowHttp));
  if (new Set(trustedOrigins).size !== trustedOrigins.length) {
    throw new ConfigError("duplicate_trusted_origin");
  }

  if (required(environment, "PAYOPS_SOLANA_CLUSTER") !== "mainnet-beta") {
    throw new ConfigError("unsupported_solana_cluster");
  }

  const emailDeliveryMode = required(environment, "PAYOPS_EMAIL_DELIVERY_MODE");
  if (emailDeliveryMode !== "test" && emailDeliveryMode !== "production") {
    throw new ConfigError("invalid_email_delivery_mode");
  }

  return Object.freeze({
    databaseUrl: required(environment, "DATABASE_URL"),
    environment: deploymentEnvironment,
    publicApiOrigin,
    trustedOrigins: Object.freeze(trustedOrigins),
    walletProofDomain: required(environment, "PAYOPS_WALLET_PROOF_DOMAIN"),
    solanaCluster: "mainnet-beta",
    solanaRpcUrl: required(environment, "PAYOPS_SOLANA_RPC_URL"),
    ingestionProviderId: parseProviderId(
      required(environment, "PAYOPS_INGESTION_PROVIDER_ID"),
    ),
    authSecrets: parseSecrets(required(environment, "BETTER_AUTH_SECRETS")),
    emailDeliveryMode,
    rateLimitMax: boundedInteger(
      environment.PAYOPS_RATE_LIMIT_MAX,
      600,
      1,
      10_000,
    ),
    rateLimitWindowSeconds: boundedInteger(
      environment.PAYOPS_RATE_LIMIT_WINDOW_SECONDS,
      60,
      1,
      3_600,
    ),
  });
}

function boundedInteger(
  value: string | undefined,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return defaultValue;
  if (!/^(0|[1-9][0-9]*)$/.test(value))
    throw new ConfigError("invalid_rate_limit_configuration");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ConfigError("invalid_rate_limit_configuration");
  }
  return parsed;
}

function parseProviderId(value: string): string {
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) {
    throw new ConfigError("invalid_ingestion_provider");
  }
  return value;
}
