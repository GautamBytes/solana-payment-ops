import { randomUUID } from "node:crypto";
import type { components, operations } from "./generated/payops-v1.js";

export type ApiErrorBody = components["schemas"]["ApiError"];
export type OrganizationContext = components["schemas"]["OrganizationContext"];
export type Customer = components["schemas"]["Customer"];
export type CreateCustomerInput = components["schemas"]["CreateCustomerInput"];
export type Invoice = components["schemas"]["Invoice"];
export type CreateInvoiceInput = components["schemas"]["CreateInvoiceInput"];
export type CancelInvoiceInput = components["schemas"]["CancelInvoiceInput"];
export type InvoiceIssuedSnapshot =
  components["schemas"]["InvoiceIssuedSnapshot"];
export type MerchantWallet = components["schemas"]["MerchantWallet"];
export type WalletChallenge = components["schemas"]["WalletChallenge"];
export type RegisterWalletInput = components["schemas"]["RegisterWalletInput"];
export type ReplaceWalletInput = components["schemas"]["ReplaceWalletInput"];
export type InvoiceStatus = components["schemas"]["InvoiceStatus"];
export type IssuedInvoice = {
  readonly invoice: Invoice;
  readonly snapshot: InvoiceIssuedSnapshot;
};
export type WalletReplacement = {
  readonly replacementId: string;
  readonly activatesAt: string;
};

export interface PayOpsClientOptions {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

export interface RequestOptions {
  readonly requestId?: string;
  readonly signal?: AbortSignal;
}

export interface MutationOptions extends RequestOptions {
  readonly idempotencyKey: string;
}

export interface ListCustomersOptions extends RequestOptions {
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ListInvoicesOptions extends ListCustomersOptions {
  readonly status?: InvoiceStatus;
  readonly customerId?: string;
}

export interface Page<T> {
  readonly data: readonly T[];
  readonly nextCursor: string | null;
}

export interface PayOpsClient {
  readonly baseUrl: string;
  getOrganization(options?: RequestOptions): Promise<OrganizationContext>;
  listCustomers(options?: ListCustomersOptions): Promise<Page<Customer>>;
  createCustomer(
    input: CreateCustomerInput,
    options: MutationOptions,
  ): Promise<Customer>;
  getCustomer(customerId: string, options?: RequestOptions): Promise<Customer>;
  listInvoices(options?: ListInvoicesOptions): Promise<Page<Invoice>>;
  createInvoice(
    input: CreateInvoiceInput,
    options: MutationOptions,
  ): Promise<Invoice>;
  getInvoice(invoiceId: string, options?: RequestOptions): Promise<Invoice>;
  issueInvoice(
    invoiceId: string,
    options: MutationOptions,
  ): Promise<IssuedInvoice>;
  cancelInvoice(
    invoiceId: string,
    input: CancelInvoiceInput,
    options: MutationOptions,
  ): Promise<Invoice>;
  listMerchantWallets(
    options?: RequestOptions,
  ): Promise<{ readonly data: readonly MerchantWallet[] }>;
  createWalletChallenge(
    address: string,
    options?: RequestOptions,
  ): Promise<WalletChallenge>;
  registerMerchantWallet(
    input: RegisterWalletInput,
    options: MutationOptions,
  ): Promise<MerchantWallet>;
  createWalletReplacementChallenge(
    walletId: string,
    address: string,
    options?: RequestOptions,
  ): Promise<WalletChallenge>;
  replaceMerchantWallet(
    walletId: string,
    input: ReplaceWalletInput,
    options: MutationOptions,
  ): Promise<MerchantWallet | WalletReplacement>;
}

export class PayOpsApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | null;
  readonly details: ApiErrorBody["details"];

  constructor(input: {
    readonly status: number;
    readonly code: string;
    readonly message: string;
    readonly requestId: string | null;
    readonly details?: ApiErrorBody["details"];
  }) {
    super(input.message);
    this.name = "PayOpsApiError";
    this.status = input.status;
    this.code = input.code;
    this.requestId = input.requestId;
    this.details = input.details;
  }
}

const MAX_RESPONSE_BYTES = 1_048_576;

export function createPayOpsClient(options: PayOpsClientOptions): PayOpsClient {
  const baseUrl = exactHttpsOrigin(options.baseUrl);
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== "function")
    throw new TypeError("fetch_required");
  if (options.apiKey !== undefined && !visibleAscii(options.apiKey, 1, 512)) {
    throw new TypeError("invalid_api_key");
  }
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new TypeError("invalid_timeout_ms");
  }

  async function request<T>(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    requestOptions: RequestOptions,
    idempotencyKey?: string,
  ): Promise<T> {
    const requestId = requestOptions.requestId ?? randomUUID();
    if (!validUuid(requestId)) throw new TypeError("invalid_request_id");
    if (
      idempotencyKey !== undefined &&
      !visibleAscii(idempotencyKey, 16, 128)
    ) {
      throw new TypeError("invalid_idempotency_key");
    }
    const timeoutController = new AbortController();
    const timeout = setTimeout(
      () =>
        timeoutController.abort(
          new DOMException("Request timed out", "TimeoutError"),
        ),
      timeoutMs,
    );
    const signal = requestOptions.signal
      ? AbortSignal.any([requestOptions.signal, timeoutController.signal])
      : timeoutController.signal;
    const headers = new Headers({
      Accept: "application/json",
      "X-Request-Id": requestId,
    });
    if (body !== undefined) headers.set("Content-Type", "application/json");
    if (options.apiKey !== undefined) headers.set("X-API-Key", options.apiKey);
    if (idempotencyKey !== undefined)
      headers.set("Idempotency-Key", idempotencyKey);
    try {
      const response = await fetchImplementation(new URL(path, baseUrl), {
        method,
        headers,
        signal,
        redirect: "error",
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const responseRequestId = response.headers.get("x-request-id");
      const parsed = await boundedJson(response);
      if (!response.ok) {
        const error = apiError(parsed);
        throw new PayOpsApiError({
          status: response.status,
          code: error?.code ?? "invalid_error_response",
          message: error?.message ?? "PayOps API request failed",
          requestId: error?.requestId ?? responseRequestId,
          ...(error?.details === undefined ? {} : { details: error.details }),
        });
      }
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      ) {
        throw new PayOpsApiError({
          status: response.status,
          code: "invalid_api_response",
          message: "PayOps API returned an invalid response",
          requestId: responseRequestId,
        });
      }
      return parsed as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  const client: PayOpsClient = {
    baseUrl,
    getOrganization: (requestOptions = {}) =>
      request<OrganizationContext>(
        "GET",
        "/v1/organization",
        undefined,
        requestOptions,
      ),
    listCustomers: (requestOptions = {}) =>
      request<Page<Customer>>(
        "GET",
        withQuery("/v1/customers", requestOptions, ["limit", "cursor"]),
        undefined,
        requestOptions,
      ),
    createCustomer: (input, requestOptions) =>
      request<Customer>(
        "POST",
        "/v1/customers",
        input,
        requestOptions,
        requestOptions.idempotencyKey,
      ),
    getCustomer: (customerId, requestOptions = {}) =>
      request<Customer>(
        "GET",
        `/v1/customers/${pathId(customerId)}`,
        undefined,
        requestOptions,
      ),
    listInvoices: (requestOptions = {}) =>
      request<Page<Invoice>>(
        "GET",
        withQuery("/v1/invoices", requestOptions, [
          "limit",
          "cursor",
          "status",
          "customerId",
        ]),
        undefined,
        requestOptions,
      ),
    createInvoice: (input, requestOptions) =>
      request<Invoice>(
        "POST",
        "/v1/invoices",
        input,
        requestOptions,
        requestOptions.idempotencyKey,
      ),
    getInvoice: (invoiceId, requestOptions = {}) =>
      request<Invoice>(
        "GET",
        `/v1/invoices/${pathId(invoiceId)}`,
        undefined,
        requestOptions,
      ),
    issueInvoice: (invoiceId, requestOptions) =>
      request<IssuedInvoice>(
        "POST",
        `/v1/invoices/${pathId(invoiceId)}/issue`,
        {},
        requestOptions,
        requestOptions.idempotencyKey,
      ),
    cancelInvoice: (invoiceId, input, requestOptions) =>
      request<Invoice>(
        "POST",
        `/v1/invoices/${pathId(invoiceId)}/cancel`,
        input,
        requestOptions,
        requestOptions.idempotencyKey,
      ),
    listMerchantWallets: (requestOptions = {}) =>
      request<{ readonly data: readonly MerchantWallet[] }>(
        "GET",
        "/v1/merchant-wallets",
        undefined,
        requestOptions,
      ),
    createWalletChallenge: (address, requestOptions = {}) =>
      request<WalletChallenge>(
        "POST",
        "/v1/merchant-wallets/challenges",
        { address },
        requestOptions,
      ),
    registerMerchantWallet: (input, requestOptions) =>
      request<MerchantWallet>(
        "POST",
        "/v1/merchant-wallets",
        input,
        requestOptions,
        requestOptions.idempotencyKey,
      ),
    createWalletReplacementChallenge: (
      walletId,
      address,
      requestOptions = {},
    ) =>
      request<WalletChallenge>(
        "POST",
        `/v1/merchant-wallets/${pathId(walletId)}/replacement-challenges`,
        { address },
        requestOptions,
      ),
    replaceMerchantWallet: (walletId, input, requestOptions) =>
      request<MerchantWallet | WalletReplacement>(
        "POST",
        `/v1/merchant-wallets/${pathId(walletId)}/replace`,
        input,
        requestOptions,
        requestOptions.idempotencyKey,
      ),
  };
  return Object.freeze(client);
}

function exactHttpsOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.origin !== value
  ) {
    throw new TypeError("invalid_base_url");
  }
  return url.origin;
}

function withQuery(
  path: string,
  options: object,
  keys: readonly string[],
): string {
  const candidate = options as {
    readonly limit?: unknown;
    readonly cursor?: unknown;
    readonly status?: unknown;
    readonly customerId?: unknown;
  };
  if (
    candidate.limit !== undefined &&
    (!Number.isSafeInteger(candidate.limit) ||
      (candidate.limit as number) < 1 ||
      (candidate.limit as number) > 100)
  )
    throw new TypeError("invalid_list_limit");
  if (
    candidate.cursor !== undefined &&
    (typeof candidate.cursor !== "string" ||
      candidate.cursor.length < 16 ||
      candidate.cursor.length > 1024)
  )
    throw new TypeError("invalid_list_cursor");
  if (
    candidate.status !== undefined &&
    !["draft", "issued", "cancelled"].includes(String(candidate.status))
  )
    throw new TypeError("invalid_invoice_status");
  if (
    candidate.customerId !== undefined &&
    (typeof candidate.customerId !== "string" ||
      !validUuid(candidate.customerId))
  )
    throw new TypeError("invalid_customer_id");
  const query = new URLSearchParams();
  for (const key of keys) {
    const value = Reflect.get(options, key) as unknown;
    if (value !== undefined) query.set(key, String(value));
  }
  const encoded = query.toString();
  return encoded === "" ? path : `${path}?${encoded}`;
}

function pathId(value: string): string {
  if (!validUuid(value)) throw new TypeError("invalid_resource_id");
  return encodeURIComponent(value);
}

async function boundedJson(response: Response): Promise<unknown> {
  const type = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (type !== "application/json") return null;
  const reader = response.body?.getReader();
  if (reader === undefined) return null;
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new PayOpsApiError({
          status: response.status,
          code: "response_too_large",
          message: "PayOps API response exceeded the size limit",
          requestId: response.headers.get("x-request-id"),
        });
      }
      chunks.push(result.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
    } catch {
      return null;
    }
  } finally {
    reader.releaseLock();
  }
}

function apiError(value: unknown): ApiErrorBody | null {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.code !== "string" ||
    record.code.length < 1 ||
    record.code.length > 128 ||
    typeof record.message !== "string" ||
    record.message.length < 1 ||
    record.message.length > 256 ||
    typeof record.requestId !== "string" ||
    !validUuid(record.requestId) ||
    !validDetails(record.details)
  )
    return null;
  return {
    code: record.code,
    message: record.message,
    requestId: record.requestId,
    ...(record.details === undefined
      ? {}
      : { details: record.details as NonNullable<ApiErrorBody["details"]> }),
  };
}

function validDetails(value: unknown): boolean {
  if (value === undefined) return true;
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const entries = Object.entries(value);
  return (
    entries.length <= 32 &&
    entries.every(
      ([key, item]) =>
        key.length <= 128 &&
        (item === null ||
          typeof item === "number" ||
          typeof item === "boolean" ||
          (typeof item === "string" && item.length <= 1024)),
    )
  );
}

function visibleAscii(
  value: string,
  minLength: number,
  maxLength: number,
): boolean {
  return (
    value.length >= minLength &&
    value.length <= maxLength &&
    /^[\x21-\x7e]+$/u.test(value)
  );
}

function validUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );
}

type _GeneratedOperationsContract = operations;
