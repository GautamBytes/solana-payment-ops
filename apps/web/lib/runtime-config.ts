export interface ExternalApiWebRuntimeConfig {
  readonly mode: "external-api";
  readonly webOrigin: string;
  readonly apiOrigin: string;
  readonly readinessOrigin: string;
}

export interface EmbeddedWebRuntimeConfig {
  readonly mode: "embedded";
  readonly rpcUrl: string;
}

export type WebRuntimeConfig =
  ExternalApiWebRuntimeConfig | EmbeddedWebRuntimeConfig;

export function parseWebRuntimeConfig(
  environment: Readonly<Record<string, string | undefined>>,
): WebRuntimeConfig {
  const embedded = own(environment, "PAYOPS_EMBEDDED_PUBLIC_ANALYSIS_ENABLED");
  if (embedded === "true") {
    if (
      own(environment, "PAYOPS_PUBLIC_ANALYSIS_EDGE_RATE_LIMITED") !== "true"
    ) {
      invalidConfiguration();
    }
    return Object.freeze({
      mode: "embedded" as const,
      rpcUrl: secureRpcUrl(
        required(environment, "PAYOPS_PUBLIC_SOLANA_RPC_URL"),
      ),
    });
  }
  if (embedded !== undefined && embedded !== "false") invalidConfiguration();

  const webOrigin = secureExactOrigin(
    required(environment, "PAYOPS_WEB_ORIGIN"),
  );
  const apiOrigin = secureExactOrigin(
    required(environment, "PAYOPS_API_ORIGIN"),
  );
  const publicApiOrigin = secureExactOrigin(
    required(environment, "NEXT_PUBLIC_PAYOPS_API_ORIGIN"),
  );
  if (apiOrigin !== publicApiOrigin) invalidConfiguration();
  const readinessOrigin = secureReadinessOrigin(
    own(environment, "PAYOPS_API_READINESS_ORIGIN") ?? apiOrigin,
  );
  return Object.freeze({
    mode: "external-api" as const,
    webOrigin,
    apiOrigin,
    readinessOrigin,
  });
}

function required(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = Object.hasOwn(environment, name)
    ? environment[name]
    : undefined;
  if (typeof value !== "string" || value.length === 0) invalidConfiguration();
  return value;
}

function own(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  return Object.hasOwn(environment, name) ? environment[name] : undefined;
}

function secureExactOrigin(value: string): string {
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.origin !== value
    ) {
      invalidConfiguration();
    }
    return parsed.origin;
  } catch {
    invalidConfiguration();
  }
}

function secureReadinessOrigin(value: string): string {
  try {
    const parsed = new URL(value);
    const privateComposeApi = value === "http://api:3000";
    if (
      (!privateComposeApi && parsed.protocol !== "https:") ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.origin !== value
    ) {
      invalidConfiguration();
    }
    return parsed.origin;
  } catch {
    invalidConfiguration();
  }
}

function secureRpcUrl(value: string): string {
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.hash !== ""
    ) {
      invalidConfiguration();
    }
    return parsed.toString();
  } catch {
    invalidConfiguration();
  }
}

function invalidConfiguration(): never {
  throw Object.assign(new Error("invalid_web_origin_configuration"), {
    code: "invalid_web_origin_configuration",
  });
}
