import { lookup } from "node:dns/promises";
import type { LookupAddress, LookupOptions } from "node:dns";
import { isIP } from "node:net";
import { Agent, request as undiciRequest, type Dispatcher } from "undici";
import type {
  DeliveryTransport,
  DeliveryTransportRequest,
  DeliveryTransportResponse,
} from "../delivery/worker.js";
import {
  assertPublicAddress,
  validateEndpointUrl,
  type EndpointPolicy,
} from "../security/endpoint-policy.js";

const defaultConnectTimeoutMs = 5_000;
const defaultHeadersTimeoutMs = 10_000;
const defaultBodyTimeoutMs = 10_000;
const defaultTotalTimeoutMs = 15_000;
const defaultMaxResponseBodyBytes = 64 * 1_024;
const maximumBound = 2_147_483_647;

export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export type HostnameResolver = (
  hostname: string,
) => Promise<readonly ResolvedAddress[]>;

export interface PinnedDispatcher {
  close(): Promise<void>;
  destroy?(): Promise<void>;
}

export interface PinnedDispatcherFactoryInput {
  readonly hostname: string;
  readonly address: string;
  readonly family: 4 | 6;
  readonly connectTimeoutMs: number;
  readonly maxResponseBodyBytes: number;
}

export interface TransportResponseBody extends AsyncIterable<
  Uint8Array<ArrayBufferLike>
> {
  destroy(): unknown;
}

export interface TransportResponse {
  readonly statusCode: number;
  readonly headers: Readonly<
    Record<string, string | readonly string[] | undefined>
  >;
  readonly body: TransportResponseBody;
}

export interface TransportRequestOptions {
  readonly method: "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly dispatcher: PinnedDispatcher;
  readonly maxRedirections: 0;
  readonly headersTimeout: number;
  readonly bodyTimeout: number;
  readonly signal: AbortSignal;
}

export type TransportRequest = (
  url: URL,
  options: TransportRequestOptions,
) => Promise<TransportResponse>;

export interface UndiciWebhookTransportDependencies {
  readonly resolver?: HostnameResolver;
  readonly createDispatcher?: (
    input: PinnedDispatcherFactoryInput,
  ) => PinnedDispatcher;
  readonly performRequest?: TransportRequest;
}

export interface UndiciWebhookTransportOptions {
  readonly connectTimeoutMs?: number;
  readonly headersTimeoutMs?: number;
  readonly bodyTimeoutMs?: number;
  readonly totalTimeoutMs?: number;
  readonly maxResponseBodyBytes?: number;
  readonly endpointPolicy?: EndpointPolicy;
}

export type WebhookTransportErrorCode =
  | "body_timeout"
  | "connect_timeout"
  | "connection_failed"
  | "dns_failed"
  | "headers_timeout"
  | "invalid_response"
  | "network_error"
  | "response_too_large"
  | "tls_failed"
  | "total_timeout"
  | "unsafe_endpoint";

export class WebhookTransportError extends Error {
  public constructor(readonly code: WebhookTransportErrorCode) {
    super("Webhook delivery failed");
    this.name = "WebhookTransportError";
  }
}

export class UndiciWebhookTransport implements DeliveryTransport {
  readonly #connectTimeoutMs: number;
  readonly #headersTimeoutMs: number;
  readonly #bodyTimeoutMs: number;
  readonly #totalTimeoutMs: number;
  readonly #maxResponseBodyBytes: number;
  readonly #endpointPolicy: EndpointPolicy | undefined;
  readonly #resolver: HostnameResolver;
  readonly #createDispatcher: (
    input: PinnedDispatcherFactoryInput,
  ) => PinnedDispatcher;
  readonly #performRequest: TransportRequest;

  public constructor(
    options: UndiciWebhookTransportOptions = {},
    dependencies: UndiciWebhookTransportDependencies = {},
  ) {
    this.#connectTimeoutMs = positiveBound(
      options.connectTimeoutMs,
      defaultConnectTimeoutMs,
      "connectTimeoutMs",
    );
    this.#headersTimeoutMs = positiveBound(
      options.headersTimeoutMs,
      defaultHeadersTimeoutMs,
      "headersTimeoutMs",
    );
    this.#bodyTimeoutMs = positiveBound(
      options.bodyTimeoutMs,
      defaultBodyTimeoutMs,
      "bodyTimeoutMs",
    );
    this.#totalTimeoutMs = positiveBound(
      options.totalTimeoutMs,
      defaultTotalTimeoutMs,
      "totalTimeoutMs",
    );
    this.#maxResponseBodyBytes = nonNegativeBound(
      options.maxResponseBodyBytes,
      defaultMaxResponseBodyBytes,
      "maxResponseBodyBytes",
    );
    this.#endpointPolicy = options.endpointPolicy;
    this.#resolver = dependencies.resolver ?? systemResolver;
    this.#createDispatcher =
      dependencies.createDispatcher ?? createUndiciDispatcher;
    this.#performRequest = dependencies.performRequest ?? performUndiciRequest;
  }

  public async send(
    request: DeliveryTransportRequest,
  ): Promise<DeliveryTransportResponse> {
    const endpoint = validateEndpointUrl(request.url, this.#endpointPolicy);
    const url = new URL(endpoint.url);
    const hostname = unbracket(url.hostname);
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(new WebhookTransportError("total_timeout"));
    }, this.#totalTimeoutMs);
    timeout.unref();
    let dispatcher: PinnedDispatcher | undefined;

    try {
      const addresses = await abortable(
        this.#resolveAndValidate(hostname),
        controller.signal,
      );
      const selectedAddress = addresses[0]!;
      dispatcher = this.#createDispatcher({
        hostname,
        address: selectedAddress.address,
        family: selectedAddress.family,
        connectTimeoutMs: this.#connectTimeoutMs,
        maxResponseBodyBytes: this.#maxResponseBodyBytes,
      });
      const response = await abortable(
        this.#performRequest(url, {
          method: "POST",
          headers: request.headers,
          body: request.body,
          dispatcher,
          maxRedirections: 0,
          headersTimeout: this.#headersTimeoutMs,
          bodyTimeout: this.#bodyTimeoutMs,
          signal: controller.signal,
        }),
        controller.signal,
      );
      if (!isHttpStatus(response.statusCode)) {
        destroyQuietly(response.body);
        throw new WebhookTransportError("invalid_response");
      }
      await abortable(
        consumeBoundedBody(response.body, this.#maxResponseBodyBytes),
        controller.signal,
        () => response.body.destroy(),
      );
      const retryAfter = response.headers["retry-after"];
      return {
        status: response.statusCode,
        retryAfter: typeof retryAfter === "string" ? retryAfter : null,
      };
    } catch (error) {
      throw safeTransportError(error, controller.signal);
    } finally {
      clearTimeout(timeout);
      if (dispatcher !== undefined) await closeQuietly(dispatcher);
    }
  }

  async #resolveAndValidate(
    hostname: string,
  ): Promise<readonly ResolvedAddress[]> {
    let addresses: readonly ResolvedAddress[];
    try {
      addresses = await this.#resolver(hostname);
    } catch (error) {
      throw safeTransportError(error);
    }
    if (addresses.length === 0) {
      throw new WebhookTransportError("dns_failed");
    }
    for (const answer of addresses) {
      if (isIP(answer.address) !== answer.family) {
        throw new WebhookTransportError("dns_failed");
      }
      assertPublicAddress(answer.address, this.#endpointPolicy);
    }
    return addresses;
  }
}

async function abortable<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  onAbort?: () => unknown,
): Promise<T> {
  if (signal.aborted) {
    try {
      onAbort?.();
    } catch {
      // The deadline result must not expose cleanup diagnostics.
    }
    throw signal.reason;
  }
  return new Promise<T>((resolve, reject) => {
    const aborted = () => {
      try {
        onAbort?.();
      } catch {
        // The deadline result must not expose response cleanup diagnostics.
      }
      reject(signal.reason);
    };
    signal.addEventListener("abort", aborted, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
  });
}

async function systemResolver(
  hostname: string,
): Promise<readonly ResolvedAddress[]> {
  const literalFamily = isIP(hostname);
  if (literalFamily === 4 || literalFamily === 6) {
    return [{ address: hostname, family: literalFamily }];
  }
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.flatMap((answer) =>
    answer.family === 4 || answer.family === 6
      ? [{ address: answer.address, family: answer.family }]
      : [],
  );
}

function createUndiciDispatcher(
  input: PinnedDispatcherFactoryInput,
): PinnedDispatcher {
  const lookupPinnedAddress = (
    _hostname: string,
    options: LookupOptions,
    callback: (
      error: NodeJS.ErrnoException | null,
      address: string | LookupAddress[],
      family?: number,
    ) => void,
  ): void => {
    if (options.all) {
      callback(null, [{ address: input.address, family: input.family }]);
      return;
    }
    callback(null, input.address, input.family);
  };
  return new Agent({
    connect: {
      lookup: lookupPinnedAddress,
      timeout: input.connectTimeoutMs,
    },
    maxResponseSize: input.maxResponseBodyBytes,
  });
}

async function performUndiciRequest(
  url: URL,
  options: TransportRequestOptions,
): Promise<TransportResponse> {
  if (options.maxRedirections !== 0) {
    throw new WebhookTransportError("invalid_response");
  }
  const requestOptions = {
    method: options.method,
    headers: options.headers,
    body: options.body,
    dispatcher: options.dispatcher as Dispatcher,
    maxRedirections: options.maxRedirections,
    headersTimeout: options.headersTimeout,
    bodyTimeout: options.bodyTimeout,
    signal: options.signal,
  };
  return undiciRequest(url, requestOptions);
}

async function consumeBoundedBody(
  body: TransportResponseBody,
  maximumBytes: number,
): Promise<void> {
  let consumedBytes = 0;
  for await (const chunk of body) {
    consumedBytes += chunk.byteLength;
    if (consumedBytes > maximumBytes) {
      destroyQuietly(body);
      throw new WebhookTransportError("response_too_large");
    }
  }
}

function safeTransportError(
  error: unknown,
  signal?: AbortSignal,
): WebhookTransportError {
  if (signal?.aborted) {
    return new WebhookTransportError("total_timeout");
  }
  return new WebhookTransportError(classifyTransportErrorCode(error));
}

function classifyTransportErrorCode(error: unknown): WebhookTransportErrorCode {
  const code = readOwnErrorCode(error);
  switch (code) {
    case "body_timeout":
    case "connect_timeout":
    case "connection_failed":
    case "dns_failed":
    case "headers_timeout":
    case "invalid_response":
    case "network_error":
    case "response_too_large":
    case "tls_failed":
    case "unsafe_endpoint":
      return code;
    case "total_timeout":
      return "network_error";
    case "UND_ERR_CONNECT_TIMEOUT":
      return "connect_timeout";
    case "UND_ERR_HEADERS_TIMEOUT":
      return "headers_timeout";
    case "UND_ERR_BODY_TIMEOUT":
      return "body_timeout";
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return "dns_failed";
    case "ECONNREFUSED":
    case "ECONNRESET":
    case "EPIPE":
    case "UND_ERR_SOCKET":
      return "connection_failed";
    case "UND_ERR_RES_EXCEEDED_MAX_SIZE":
      return "response_too_large";
    case "ERR_TLS_CERT_ALTNAME_INVALID":
    case "ERR_TLS_CERT_SIGNATURE_ALGORITHM_UNSUPPORTED":
    case "ERR_TLS_DH_PARAM_SIZE":
    case "ERR_TLS_HANDSHAKE_TIMEOUT":
    case "CERT_HAS_EXPIRED":
    case "CERT_NOT_YET_VALID":
    case "CERT_REVOKED":
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
    case "SELF_SIGNED_CERT_IN_CHAIN":
    case "UNABLE_TO_GET_ISSUER_CERT":
    case "UNABLE_TO_GET_ISSUER_CERT_LOCALLY":
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
    case "INVALID_CA":
      return "tls_failed";
    default:
      return "network_error";
  }
}

function readOwnErrorCode(error: unknown): string {
  if (
    (typeof error !== "object" || error === null) &&
    typeof error !== "function"
  ) {
    return "";
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, "code");
    if (descriptor === undefined || !("value" in descriptor)) return "";
    const code = descriptor.value;
    return typeof code === "string" && code.length <= 64 ? code : "";
  } catch {
    return "";
  }
}

function destroyQuietly(body: TransportResponseBody): void {
  try {
    body.destroy();
  } catch {
    // Response cleanup must not replace the bounded delivery outcome.
  }
}

async function closeQuietly(dispatcher: PinnedDispatcher): Promise<void> {
  try {
    if (dispatcher.destroy !== undefined) await dispatcher.destroy();
    else await dispatcher.close();
  } catch {
    // A completed request result must not be replaced by cleanup diagnostics.
  }
}

function positiveBound(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > maximumBound) {
    throw new TypeError(`${name} must be a positive bounded integer`);
  }
  return resolved;
}

function nonNegativeBound(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 0 || resolved > maximumBound) {
    throw new TypeError(`${name} must be a non-negative bounded integer`);
  }
  return resolved;
}

function isHttpStatus(value: number): boolean {
  return Number.isInteger(value) && value >= 100 && value <= 599;
}

function unbracket(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "");
}
