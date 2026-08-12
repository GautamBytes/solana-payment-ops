const maximumResponseBytes = 256 * 1024;
const defaultTimeoutMs = 5_000;

export type QuoteProviderErrorCode =
  | "invalid_rate_provider_configuration"
  | "rate_provider_unavailable"
  | "rate_provider_invalid_response"
  | "rate_provider_response_too_large";

export class QuoteProviderError extends Error {
  public constructor(readonly code: QuoteProviderErrorCode) {
    super("Rate provider request failed");
    this.name = "QuoteProviderError";
  }
}

export interface ProviderHttpDependencies {
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
}

export function exactProviderBaseUrl(value: string): URL {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      url.hostname === "" ||
      url.port !== ""
    ) {
      throw new Error("unsafe provider URL");
    }
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url;
  } catch {
    throw new QuoteProviderError("invalid_rate_provider_configuration");
  }
}

export async function providerGet(
  url: URL,
  headers: Readonly<Record<string, string>>,
  signal: AbortSignal,
  fetchImplementation: typeof globalThis.fetch,
): Promise<{ readonly body: string; readonly contentType: string }> {
  try {
    const response = await fetchImplementation(url, {
      method: "GET",
      headers,
      redirect: "manual",
      signal: AbortSignal.any([signal, AbortSignal.timeout(defaultTimeoutMs)]),
    });
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      throw new QuoteProviderError("rate_provider_unavailable");
    }
    return {
      body: await boundedText(response),
      contentType: response.headers.get("content-type") ?? "",
    };
  } catch (error) {
    const code = safeProviderCode(error);
    if (code !== undefined) throw new QuoteProviderError(code);
    throw new QuoteProviderError("rate_provider_unavailable");
  }
}

async function boundedText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined)
    throw new QuoteProviderError("rate_provider_invalid_response");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > maximumResponseBytes) {
        await reader.cancel().catch(() => undefined);
        throw new QuoteProviderError("rate_provider_response_too_large");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new QuoteProviderError("rate_provider_invalid_response");
  }
}

function safeProviderCode(error: unknown): QuoteProviderErrorCode | undefined {
  if (
    error === null ||
    (typeof error !== "object" && typeof error !== "function")
  ) {
    return undefined;
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, "code");
    const code =
      descriptor !== undefined &&
      "value" in descriptor &&
      typeof descriptor.value === "string"
        ? descriptor.value
        : undefined;
    return code === "invalid_rate_provider_configuration" ||
      code === "rate_provider_unavailable" ||
      code === "rate_provider_invalid_response" ||
      code === "rate_provider_response_too_large"
      ? code
      : undefined;
  } catch {
    return undefined;
  }
}
