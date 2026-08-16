import {
  parseRpcProviderConfiguration,
  type RpcProviderConfiguration,
} from "@payops/platform";

export type PayOpsEnvironment = "local" | "test" | "production";

export interface ApiConfig {
  readonly databaseUrl: string;
  readonly productionControlDatabaseUrl: string;
  readonly readinessVerifierDatabaseUrl: string;
  readonly environment: PayOpsEnvironment;
  readonly publicApiOrigin: string;
  readonly checkoutOrigin: string;
  readonly trustedOrigins: readonly string[];
  readonly walletProofDomain: string;
  readonly solanaCluster: "mainnet-beta";
  readonly solanaRpcUrl: string;
  readonly ingestionProviderId: string;
  readonly rpc: RpcProviderConfiguration;
  readonly authSecrets: readonly string[];
  readonly checkoutTokenKeys: readonly {
    readonly id: string;
    readonly secret: string;
  }[];
  readonly pythHermesEndpoint: string;
  readonly pythAccessToken: string;
  readonly pythFeedIds: Readonly<{
    readonly USDC: string;
    readonly USDT: string;
  }>;
  readonly ecbEndpoint: string;
  readonly commercialFx?: Readonly<{
    readonly endpoint: string;
    readonly accessToken: string;
  }>;
  readonly evidenceSigning?: Readonly<{
    readonly keyId: string;
    readonly privateKeyPem: string;
  }>;
  readonly emailDeliveryMode: "test" | "production";
  readonly rateLimitMax: number;
  readonly rateLimitWindowSeconds: number;
  readonly publicAnalysis?: Readonly<{
    readonly clientDigestSecret: string;
    readonly clientLimit: number;
    readonly globalLimit: number;
    readonly windowSeconds: number;
  }>;
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
  const value = own(environment, name);
  if (typeof value !== "string" || value.length === 0) {
    throw new ConfigError("missing_configuration");
  }
  return value;
}

function own(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  return Object.hasOwn(environment, name) ? environment[name] : undefined;
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
  const databaseUrl = required(environment, "DATABASE_URL");
  const productionControlDatabaseUrl =
    own(environment, "PAYOPS_PRODUCTION_CONTROL_DATABASE_URL") ?? databaseUrl;
  const readinessVerifierDatabaseUrl =
    own(environment, "PAYOPS_READINESS_VERIFIER_DATABASE_URL") ?? databaseUrl;
  if (
    deploymentEnvironment === "production" &&
    (productionControlDatabaseUrl === databaseUrl ||
      readinessVerifierDatabaseUrl === databaseUrl ||
      databasePrincipal(productionControlDatabaseUrl) ===
        databasePrincipal(databaseUrl) ||
      databasePrincipal(readinessVerifierDatabaseUrl) ===
        databasePrincipal(databaseUrl) ||
      databasePrincipal(productionControlDatabaseUrl) ===
        databasePrincipal(readinessVerifierDatabaseUrl))
  ) {
    throw new ConfigError("unsafe_production_database_role_configuration");
  }

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

  const checkoutOrigin = exactOrigin(
    required(environment, "PAYOPS_CHECKOUT_ORIGIN"),
    allowHttp,
  );

  let rpc: RpcProviderConfiguration;
  try {
    rpc = parseRpcProviderConfiguration(environment, deploymentEnvironment);
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      Object.getOwnPropertyDescriptor(error, "code")?.value ===
        "missing_configuration"
    ) {
      throw new ConfigError("missing_configuration");
    }
    throw new ConfigError("invalid_rpc_configuration");
  }
  if (rpc.cluster !== "mainnet-beta") {
    throw new ConfigError("unsupported_solana_cluster");
  }

  const emailDeliveryMode = required(environment, "PAYOPS_EMAIL_DELIVERY_MODE");
  if (emailDeliveryMode !== "test" && emailDeliveryMode !== "production") {
    throw new ConfigError("invalid_email_delivery_mode");
  }

  const commercialFx = parseCommercialFx(environment);
  const evidenceSigning = parseEvidenceSigning(
    environment,
    deploymentEnvironment,
  );
  const publicAnalysis = parsePublicAnalysis(environment);
  return Object.freeze({
    databaseUrl,
    productionControlDatabaseUrl,
    readinessVerifierDatabaseUrl,
    environment: deploymentEnvironment,
    publicApiOrigin,
    checkoutOrigin,
    trustedOrigins: Object.freeze(trustedOrigins),
    walletProofDomain: required(environment, "PAYOPS_WALLET_PROOF_DOMAIN"),
    solanaCluster: "mainnet-beta",
    solanaRpcUrl: rpc.primary.endpoint,
    ingestionProviderId: rpc.primary.providerId,
    rpc,
    authSecrets: parseSecrets(required(environment, "BETTER_AUTH_SECRETS")),
    checkoutTokenKeys: parseCheckoutTokenKeys(
      required(environment, "PAYOPS_CHECKOUT_TOKEN_KEYS"),
    ),
    pythHermesEndpoint: required(environment, "PAYOPS_PYTH_HERMES_ENDPOINT"),
    pythAccessToken: required(environment, "PAYOPS_PYTH_ACCESS_TOKEN"),
    pythFeedIds: Object.freeze({
      USDC: parseFeedId(required(environment, "PAYOPS_PYTH_USDC_FEED_ID")),
      USDT: parseFeedId(required(environment, "PAYOPS_PYTH_USDT_FEED_ID")),
    }),
    ecbEndpoint: required(environment, "PAYOPS_ECB_ENDPOINT"),
    ...(commercialFx === undefined ? {} : { commercialFx }),
    ...(evidenceSigning === undefined ? {} : { evidenceSigning }),
    emailDeliveryMode,
    rateLimitMax: boundedInteger(
      own(environment, "PAYOPS_RATE_LIMIT_MAX"),
      600,
      1,
      10_000,
    ),
    rateLimitWindowSeconds: boundedInteger(
      own(environment, "PAYOPS_RATE_LIMIT_WINDOW_SECONDS"),
      60,
      1,
      3_600,
    ),
    ...(publicAnalysis === undefined ? {} : { publicAnalysis }),
  });
}

function parsePublicAnalysis(
  environment: NodeJS.ProcessEnv,
): ApiConfig["publicAnalysis"] {
  const enabled = own(environment, "PAYOPS_PUBLIC_ANALYSIS_ENABLED") ?? "false";
  if (enabled === "false") return undefined;
  if (enabled !== "true") {
    throw new ConfigError("invalid_public_analysis_configuration");
  }

  const clientDigestSecret = required(
    environment,
    "PAYOPS_PUBLIC_ANALYSIS_CLIENT_DIGEST_SECRET",
  );
  if (
    !/^[A-Za-z0-9_-]+$/.test(clientDigestSecret) ||
    Buffer.from(clientDigestSecret, "base64url").byteLength < 32 ||
    Buffer.from(clientDigestSecret, "base64url").byteLength > 128 ||
    Buffer.from(clientDigestSecret, "base64url").toString("base64url") !==
      clientDigestSecret
  ) {
    throw new ConfigError("invalid_public_analysis_configuration");
  }

  const parseLimit = (
    name: string,
    defaultValue: number,
    maximum: number,
  ): number => {
    const value = own(environment, name);
    if (value === undefined) return defaultValue;
    if (!/^[1-9][0-9]*$/.test(value)) {
      throw new ConfigError("invalid_public_analysis_configuration");
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
      throw new ConfigError("invalid_public_analysis_configuration");
    }
    return parsed;
  };
  const clientLimit = parseLimit("PAYOPS_PUBLIC_ANALYSIS_CLIENT_LIMIT", 5, 100);
  const globalLimit = parseLimit(
    "PAYOPS_PUBLIC_ANALYSIS_GLOBAL_LIMIT",
    100,
    10_000,
  );
  if (globalLimit < clientLimit) {
    throw new ConfigError("invalid_public_analysis_configuration");
  }
  return Object.freeze({
    clientDigestSecret,
    clientLimit,
    globalLimit,
    windowSeconds: parseLimit(
      "PAYOPS_PUBLIC_ANALYSIS_WINDOW_SECONDS",
      60,
      3_600,
    ),
  });
}

function databasePrincipal(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError("invalid_database_configuration");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    url.username.length === 0
  ) {
    throw new ConfigError("invalid_database_configuration");
  }
  return decodeURIComponent(url.username);
}

export function hasReadyRpcConfiguration(config: ApiConfig): boolean {
  const rpc = config.rpc;
  if (
    rpc.cluster !== "mainnet-beta" ||
    rpc.primary.providerId !== config.ingestionProviderId ||
    rpc.primary.endpoint !== config.solanaRpcUrl ||
    !validResolvedProvider(rpc.primary, config.environment)
  ) {
    return false;
  }
  if (rpc.mode === "single_provider") {
    return rpc.cluster !== "mainnet-beta" && rpc.secondary === undefined;
  }
  return (
    rpc.secondary !== undefined &&
    rpc.primary.providerId !== rpc.secondary.providerId &&
    rpc.primary.endpointEnvironment !== rpc.secondary.endpointEnvironment &&
    validResolvedProvider(rpc.secondary, config.environment)
  );
}

function validResolvedProvider(
  provider: RpcProviderConfiguration["primary"],
  environment: PayOpsEnvironment,
): boolean {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(provider.providerId) ||
    !/^[A-Z][A-Z0-9_]{0,127}$/.test(provider.endpointEnvironment)
  ) {
    return false;
  }
  try {
    const endpoint = new URL(provider.endpoint);
    return (
      endpoint.username === "" &&
      endpoint.password === "" &&
      endpoint.hash === "" &&
      (endpoint.protocol === "https:" ||
        (environment !== "production" && endpoint.protocol === "http:"))
    );
  } catch {
    return false;
  }
}

function parseEvidenceSigning(
  environment: NodeJS.ProcessEnv,
  deploymentEnvironment: PayOpsEnvironment,
): ApiConfig["evidenceSigning"] {
  const keyId = own(environment, "PAYOPS_EVIDENCE_SIGNING_KEY_ID");
  const encoded = own(environment, "PAYOPS_EVIDENCE_SIGNING_PRIVATE_KEY_B64");
  if (keyId === undefined && encoded === undefined) {
    if (deploymentEnvironment === "production") {
      throw new ConfigError("missing_evidence_signing_configuration");
    }
    return undefined;
  }
  if (
    typeof keyId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(keyId) ||
    typeof encoded !== "string" ||
    encoded.length < 64 ||
    encoded.length > 16_384 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
  ) {
    throw new ConfigError("invalid_evidence_signing_configuration");
  }
  let privateKeyPem: string;
  try {
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") !== encoded)
      throw new Error("noncanonical base64");
    privateKeyPem = bytes.toString("utf8");
    if (
      !privateKeyPem.startsWith("-----BEGIN PRIVATE KEY-----\n") ||
      !privateKeyPem.endsWith("-----END PRIVATE KEY-----\n")
    ) {
      throw new Error("invalid PKCS8 PEM");
    }
  } catch {
    throw new ConfigError("invalid_evidence_signing_configuration");
  }
  return Object.freeze({ keyId, privateKeyPem });
}

function parseCommercialFx(
  environment: NodeJS.ProcessEnv,
): ApiConfig["commercialFx"] {
  const endpoint = own(environment, "PAYOPS_COMMERCIAL_FX_ENDPOINT");
  const accessToken = own(environment, "PAYOPS_COMMERCIAL_FX_TOKEN");
  if (endpoint === undefined && accessToken === undefined) return undefined;
  if (
    typeof endpoint !== "string" ||
    typeof accessToken !== "string" ||
    !/^[\x21-\x7e]{16,512}$/.test(accessToken)
  ) {
    throw new ConfigError("invalid_commercial_fx_configuration");
  }
  try {
    const url = new URL(endpoint);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      url.hostname === "" ||
      url.port !== ""
    ) {
      throw new Error("unsafe commercial FX URL");
    }
  } catch {
    throw new ConfigError("invalid_commercial_fx_configuration");
  }
  return Object.freeze({ endpoint, accessToken });
}

function parseCheckoutTokenKeys(
  value: string,
): readonly { readonly id: string; readonly secret: string }[] {
  const keys = value.split(",").map((entry) => {
    const separator = entry.indexOf(":");
    const id = entry.slice(0, separator);
    const secret = entry.slice(separator + 1);
    if (
      separator < 1 ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id) ||
      Buffer.from(secret, "base64url").byteLength !== 32 ||
      Buffer.from(secret, "base64url").toString("base64url") !== secret
    ) {
      throw new ConfigError("invalid_checkout_token_key");
    }
    return Object.freeze({ id, secret });
  });
  if (
    keys.length < 1 ||
    keys.length > 8 ||
    new Set(keys.map(({ id }) => id)).size !== keys.length
  ) {
    throw new ConfigError("invalid_checkout_token_key");
  }
  return Object.freeze(keys);
}

function parseFeedId(value: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new ConfigError("invalid_pyth_feed_id");
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
  if (!/^(0|[1-9][0-9]*)$/.test(value))
    throw new ConfigError("invalid_rate_limit_configuration");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ConfigError("invalid_rate_limit_configuration");
  }
  return parsed;
}
