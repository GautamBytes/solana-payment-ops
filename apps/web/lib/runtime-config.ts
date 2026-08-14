export interface WebRuntimeConfig {
  readonly webOrigin: string;
  readonly apiOrigin: string;
}

export function parseWebRuntimeConfig(
  environment: Readonly<Record<string, string | undefined>>,
): WebRuntimeConfig {
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
  return Object.freeze({ webOrigin, apiOrigin });
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

function invalidConfiguration(): never {
  throw Object.assign(new Error("invalid_web_origin_configuration"), {
    code: "invalid_web_origin_configuration",
  });
}
