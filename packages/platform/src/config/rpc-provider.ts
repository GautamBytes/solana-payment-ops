import { createHash } from "node:crypto";

export type DeploymentEnvironment = "local" | "test" | "production";
export type RpcDeploymentMode = "single_provider" | "dual_provider";
export type RpcCluster = "mainnet-beta" | "devnet" | "localnet";

export interface ResolvedRpcProvider {
  readonly providerId: string;
  readonly endpointEnvironment: string;
  readonly endpoint: string;
}

export interface RpcProviderConfiguration {
  readonly mode: RpcDeploymentMode;
  readonly cluster: RpcCluster;
  readonly primary: ResolvedRpcProvider;
  readonly secondary?: ResolvedRpcProvider;
}

export interface RpcProviderConfigurationIdentity {
  readonly mode: RpcDeploymentMode;
  readonly cluster: RpcCluster;
  readonly primaryProviderId: string;
  readonly primaryEndpointEnvironment: string;
  readonly primaryEndpointDigest: string;
  readonly secondaryProviderId: string | null;
  readonly secondaryEndpointEnvironment: string | null;
  readonly secondaryEndpointDigest: string | null;
}

export function rpcProviderConfigurationIdentity(
  configuration: RpcProviderConfiguration,
): RpcProviderConfigurationIdentity {
  return Object.freeze({
    mode: configuration.mode,
    cluster: configuration.cluster,
    primaryProviderId: configuration.primary.providerId,
    primaryEndpointEnvironment: configuration.primary.endpointEnvironment,
    primaryEndpointDigest: endpointDigest(configuration.primary.endpoint),
    secondaryProviderId:
      configuration.mode === "dual_provider"
        ? (configuration.secondary?.providerId ?? null)
        : null,
    secondaryEndpointEnvironment:
      configuration.mode === "dual_provider"
        ? (configuration.secondary?.endpointEnvironment ?? null)
        : null,
    secondaryEndpointDigest:
      configuration.mode === "dual_provider" && configuration.secondary
        ? endpointDigest(configuration.secondary.endpoint)
        : null,
  });
}

function endpointDigest(endpoint: string): string {
  return createHash("sha256").update(canonicalEndpoint(endpoint)).digest("hex");
}

export class RpcProviderConfigurationError extends Error {
  public readonly code: "missing_configuration" | "invalid_rpc_configuration";

  public constructor(
    code: "missing_configuration" | "invalid_rpc_configuration",
  ) {
    super("RPC provider configuration is invalid");
    this.name = "RpcProviderConfigurationError";
    this.code = code;
  }
}

export function parseRpcProviderConfiguration(
  environment: NodeJS.ProcessEnv,
  deploymentEnvironment: DeploymentEnvironment,
): RpcProviderConfiguration {
  const cluster = required(environment, "PAYOPS_SOLANA_CLUSTER");
  if (!isCluster(cluster)) throw invalid();
  if (deploymentEnvironment === "production" && cluster !== "mainnet-beta") {
    throw invalid();
  }
  const mode = required(environment, "PAYOPS_RPC_MODE");
  if (mode !== "single_provider" && mode !== "dual_provider") throw invalid();
  if (deploymentEnvironment === "production" && mode !== "dual_provider") {
    throw invalid();
  }

  const primary = parseProvider(environment, "PRIMARY", deploymentEnvironment);
  if (mode === "single_provider") {
    if (
      cluster === "mainnet-beta" ||
      own(environment, "PAYOPS_RPC_SECONDARY_PROVIDER_ID") !== undefined ||
      own(environment, "PAYOPS_RPC_SECONDARY_ENDPOINT_ENV") !== undefined
    ) {
      throw invalid();
    }
    return Object.freeze({ mode, cluster, primary });
  }

  const secondary = parseProvider(
    environment,
    "SECONDARY",
    deploymentEnvironment,
  );
  if (
    primary.providerId === secondary.providerId ||
    primary.endpointEnvironment === secondary.endpointEnvironment ||
    canonicalEndpoint(primary.endpoint) ===
      canonicalEndpoint(secondary.endpoint)
  ) {
    throw invalid();
  }
  return Object.freeze({ mode, cluster, primary, secondary });
}

function canonicalEndpoint(endpoint: string): string {
  const parsed = new URL(endpoint);
  if (parsed.hostname.endsWith(".")) {
    parsed.hostname = parsed.hostname.slice(0, -1);
  }
  const pathname = normalizePercentEncoding(parsed.pathname);
  if (pathname !== parsed.pathname) parsed.pathname = pathname;
  const search = normalizePercentEncoding(parsed.search);
  if (search !== parsed.search) parsed.search = search;
  return parsed.href;
}

function normalizePercentEncoding(value: string): string {
  return value.replace(/%[0-9A-Fa-f]{2}/g, (encoded) => {
    const decoded = String.fromCharCode(Number.parseInt(encoded.slice(1), 16));
    return /^[A-Za-z0-9._~-]$/.test(decoded) ? decoded : encoded.toUpperCase();
  });
}

function parseProvider(
  environment: NodeJS.ProcessEnv,
  role: "PRIMARY" | "SECONDARY",
  deploymentEnvironment: DeploymentEnvironment,
): ResolvedRpcProvider {
  const providerId = required(environment, `PAYOPS_RPC_${role}_PROVIDER_ID`);
  const endpointEnvironment = required(
    environment,
    `PAYOPS_RPC_${role}_ENDPOINT_ENV`,
  );
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(providerId) ||
    !/^[A-Z][A-Z0-9_]{0,127}$/.test(endpointEnvironment)
  ) {
    throw invalid();
  }
  const endpoint = required(environment, endpointEnvironment);
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw invalid();
  }
  const allowedProtocol =
    parsed.protocol === "https:" ||
    (deploymentEnvironment !== "production" && parsed.protocol === "http:");
  if (
    !allowedProtocol ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hash !== ""
  ) {
    throw invalid();
  }
  return Object.freeze({ providerId, endpointEnvironment, endpoint });
}

function own(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  return Object.hasOwn(environment, name) ? environment[name] : undefined;
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = own(environment, name);
  if (typeof value !== "string" || value.length === 0) {
    throw new RpcProviderConfigurationError("missing_configuration");
  }
  return value;
}

function invalid(): RpcProviderConfigurationError {
  return new RpcProviderConfigurationError("invalid_rpc_configuration");
}

function isCluster(value: string): value is RpcCluster {
  return ["mainnet-beta", "devnet", "localnet"].includes(value);
}
