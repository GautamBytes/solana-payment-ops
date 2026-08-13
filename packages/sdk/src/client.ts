import { randomUUID } from "node:crypto";
import type { components, operations } from "./generated/payops-v1.js";

export type ApiErrorBody = components["schemas"]["ApiError"];
export type OrganizationContext = components["schemas"]["OrganizationContext"];
export type Customer = components["schemas"]["Customer"];
export type CreateCustomerInput = components["schemas"]["CreateCustomerInput"];
export type Invoice = components["schemas"]["Invoice"];
export type CreateInvoiceInput = components["schemas"]["CreateInvoiceInput"];
export type CancelInvoiceInput = components["schemas"]["CancelInvoiceInput"];
export type CheckoutLink = components["schemas"]["CheckoutLink"];
export type CreatePaymentAttemptInput =
  components["schemas"]["CreatePaymentAttemptInput"];
export type PublicPaymentAttempt =
  components["schemas"]["PublicPaymentAttempt"];
export type InvoiceIssuedSnapshot =
  components["schemas"]["InvoiceIssuedSnapshot"];
export type MerchantWallet = components["schemas"]["MerchantWallet"];
export type WalletChallenge = components["schemas"]["WalletChallenge"];
export type RegisterWalletInput = components["schemas"]["RegisterWalletInput"];
export type ReplaceWalletInput = components["schemas"]["ReplaceWalletInput"];
export type InvoiceStatus = components["schemas"]["InvoiceStatus"];
export type ExceptionReviewState =
  components["schemas"]["ExceptionReviewState"];
export type PaymentException = components["schemas"]["PaymentException"];
export type ExceptionCaseEvent = components["schemas"]["ExceptionCaseEvent"];
export type AssignExceptionInput =
  components["schemas"]["AssignExceptionInput"];
export type ResolveExceptionInput =
  components["schemas"]["ResolveExceptionInput"];
export type TransitionExceptionInput =
  components["schemas"]["TransitionExceptionInput"];
export type CreateEvidencePackInput =
  components["schemas"]["CreateEvidencePackInput"];
export type EvidencePack = components["schemas"]["EvidencePack"];
export type EvidenceVerification =
  components["schemas"]["EvidenceVerification"];
export type AccountingExportFormat =
  components["schemas"]["AccountingExportFormat"];
export type CreateAccountingExportInput =
  components["schemas"]["CreateAccountingExportInput"];
export type AccountingExport = components["schemas"]["AccountingExport"];
export type ProductionControlView =
  components["schemas"]["ProductionControlView"];
export type ProductionPromotionResult =
  components["schemas"]["ProductionPromotionResult"];
export type PromoteProductionLiveInput =
  components["schemas"]["PromoteProductionLiveInput"];
export type OperationalHealthSnapshot =
  components["schemas"]["OperationalHealthSnapshot"];
export type OperationalIncident = components["schemas"]["OperationalIncident"];
export type OperationalIncidentEvent =
  components["schemas"]["OperationalIncidentEvent"];
export type OperationalIncidentKind =
  components["schemas"]["OperationalIncidentKind"];
export type OperationalIncidentState =
  components["schemas"]["OperationalIncidentState"];
export type AcknowledgeOperationalIncidentInput =
  components["schemas"]["AcknowledgeOperationalIncidentInput"];
export type ResolveOperationalIncidentInput =
  components["schemas"]["ResolveOperationalIncidentInput"];
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
  readonly sessionCookie?: string;
  readonly sessionOrigin?: string;
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

export interface ListPaymentExceptionsOptions extends ListCustomersOptions {
  readonly state?: ExceptionReviewState;
}

export interface ListOperationalIncidentsOptions extends ListCustomersOptions {
  readonly state?: OperationalIncidentState;
  readonly kind?: OperationalIncidentKind;
}

export type ListOperationalIncidentHistoryOptions = ListCustomersOptions;

export interface Page<T> {
  readonly data: readonly T[];
  readonly nextCursor: string | null;
}

export interface EvidenceArtifactDownload {
  readonly bytes: Uint8Array;
  readonly manifestDigest: string;
  readonly signature: string;
  readonly signingKeyId: string;
}

export interface AccountingExportDownload {
  readonly bytes: Uint8Array;
  readonly contentDigest: string;
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
  createCheckoutLink(
    invoiceId: string,
    options?: RequestOptions,
  ): Promise<CheckoutLink>;
  createPaymentAttempt(
    invoiceId: string,
    input: CreatePaymentAttemptInput,
    options?: RequestOptions,
  ): Promise<PublicPaymentAttempt>;
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
  listPaymentExceptions(
    options?: ListPaymentExceptionsOptions,
  ): Promise<Page<PaymentException>>;
  getPaymentExceptionHistory(
    exceptionId: string,
    options?: RequestOptions,
  ): Promise<{ readonly data: readonly ExceptionCaseEvent[] }>;
  assignPaymentException(
    exceptionId: string,
    input: AssignExceptionInput,
    options: MutationOptions,
  ): Promise<PaymentException>;
  resolvePaymentException(
    exceptionId: string,
    input: ResolveExceptionInput,
    options: MutationOptions,
  ): Promise<PaymentException>;
  startPaymentExceptionInvestigation(
    exceptionId: string,
    input: TransitionExceptionInput,
    options: MutationOptions,
  ): Promise<PaymentException>;
  escalatePaymentException(
    exceptionId: string,
    input: TransitionExceptionInput,
    options: MutationOptions,
  ): Promise<PaymentException>;
  reopenPaymentException(
    exceptionId: string,
    input: TransitionExceptionInput,
    options: MutationOptions,
  ): Promise<PaymentException>;
  createEvidencePack(
    input: CreateEvidencePackInput,
    options: MutationOptions,
  ): Promise<EvidencePack>;
  downloadEvidencePack(
    evidencePackId: string,
    format: "json" | "pdf",
    options?: RequestOptions,
  ): Promise<EvidenceArtifactDownload>;
  getEvidencePackVerification(
    evidencePackId: string,
    options?: RequestOptions,
  ): Promise<EvidenceVerification>;
  createAccountingExport(
    input: CreateAccountingExportInput,
    options: MutationOptions,
  ): Promise<AccountingExport>;
  downloadAccountingExport(
    exportId: string,
    options?: RequestOptions,
  ): Promise<AccountingExportDownload>;
  getProductionControl(
    options?: RequestOptions,
  ): Promise<ProductionControlView>;
  getOperationalHealth(
    options?: RequestOptions,
  ): Promise<OperationalHealthSnapshot>;
  listOperationalIncidents(
    options?: ListOperationalIncidentsOptions,
  ): Promise<Page<OperationalIncident>>;
  getOperationalIncidentHistory(
    incidentId: string,
    options?: ListOperationalIncidentHistoryOptions,
  ): Promise<Page<OperationalIncidentEvent>>;
  acknowledgeOperationalIncident(
    incidentId: string,
    input: AcknowledgeOperationalIncidentInput,
    options: MutationOptions,
  ): Promise<OperationalIncident>;
  resolveOperationalIncident(
    incidentId: string,
    input: ResolveOperationalIncidentInput,
    options: MutationOptions,
  ): Promise<OperationalIncident>;
  promoteProductionLive(
    input: PromoteProductionLiveInput,
    options: MutationOptions,
  ): Promise<ProductionPromotionResult>;
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
const MAX_BINARY_RESPONSE_BYTES = 52_428_800;

export function createPayOpsClient(options: PayOpsClientOptions): PayOpsClient {
  const baseUrl = exactHttpsOrigin(options.baseUrl);
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== "function")
    throw new TypeError("fetch_required");
  if (options.apiKey !== undefined && !visibleAscii(options.apiKey, 1, 512)) {
    throw new TypeError("invalid_api_key");
  }
  if (
    options.sessionCookie !== undefined &&
    !validSessionCookie(options.sessionCookie)
  ) {
    throw new TypeError("invalid_session_cookie");
  }
  if (
    (options.sessionCookie === undefined) !==
    (options.sessionOrigin === undefined)
  ) {
    throw new TypeError("invalid_session_authentication");
  }
  const sessionOrigin =
    options.sessionOrigin === undefined
      ? undefined
      : exactSessionOrigin(options.sessionOrigin);
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
    acceptsResponse?: (status: number, value: unknown) => boolean,
    authentication: "default" | "session" = "default",
  ): Promise<T> {
    const requestId = requestOptions.requestId ?? randomUUID();
    if (!validUuid(requestId)) throw new TypeError("invalid_request_id");
    if (
      idempotencyKey !== undefined &&
      !visibleAscii(idempotencyKey, 16, 128)
    ) {
      throw new TypeError("invalid_idempotency_key");
    }
    if (authentication === "session" && options.sessionCookie === undefined) {
      throw new TypeError("session_cookie_required");
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
    if (authentication === "session") {
      headers.set("Cookie", options.sessionCookie!);
      headers.set("Origin", sessionOrigin!);
    } else if (options.apiKey !== undefined) {
      headers.set("X-API-Key", options.apiKey);
    } else if (options.sessionCookie !== undefined) {
      headers.set("Cookie", options.sessionCookie);
    }
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
      if (!response.ok && acceptsResponse?.(response.status, parsed) !== true) {
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

  async function download(
    path: string,
    accept: string,
    requestOptions: RequestOptions,
  ): Promise<{ readonly bytes: Uint8Array; readonly headers: Headers }> {
    const requestId = requestOptions.requestId ?? randomUUID();
    if (!validUuid(requestId)) throw new TypeError("invalid_request_id");
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
    const headers = new Headers({ Accept: accept, "X-Request-Id": requestId });
    if (options.apiKey !== undefined) headers.set("X-API-Key", options.apiKey);
    try {
      const response = await fetchImplementation(new URL(path, baseUrl), {
        method: "GET",
        headers,
        signal,
        redirect: "error",
      });
      if (!response.ok) {
        const parsed = await boundedJson(response);
        const error = apiError(parsed);
        throw new PayOpsApiError({
          status: response.status,
          code: error?.code ?? "invalid_error_response",
          message: error?.message ?? "PayOps API request failed",
          requestId: error?.requestId ?? response.headers.get("x-request-id"),
          ...(error?.details === undefined ? {} : { details: error.details }),
        });
      }
      const responseType = response.headers
        .get("content-type")
        ?.split(";", 1)[0]
        ?.trim();
      if (responseType !== accept) {
        throw invalidApiResponse(response);
      }
      return {
        bytes: await boundedBytes(response, MAX_BINARY_RESPONSE_BYTES),
        headers: response.headers,
      };
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
    createCheckoutLink: (invoiceId, requestOptions = {}) =>
      request<CheckoutLink>(
        "POST",
        `/v1/invoices/${pathId(invoiceId)}/checkout-links`,
        {},
        requestOptions,
      ),
    createPaymentAttempt: (invoiceId, input, requestOptions = {}) =>
      request<PublicPaymentAttempt>(
        "POST",
        `/v1/invoices/${pathId(invoiceId)}/payment-attempts`,
        input,
        requestOptions,
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
    listPaymentExceptions: (requestOptions = {}) =>
      request<Page<PaymentException>>(
        "GET",
        withQuery("/v1/exceptions", requestOptions, [
          "limit",
          "cursor",
          "state",
        ]),
        undefined,
        requestOptions,
      ),
    getPaymentExceptionHistory: (exceptionId, requestOptions = {}) =>
      request<{ readonly data: readonly ExceptionCaseEvent[] }>(
        "GET",
        `/v1/exceptions/${pathId(exceptionId)}/history`,
        undefined,
        requestOptions,
      ),
    assignPaymentException: (exceptionId, input, requestOptions) =>
      request<PaymentException>(
        "POST",
        `/v1/exceptions/${pathId(exceptionId)}/assign`,
        input,
        requestOptions,
        requestOptions.idempotencyKey,
      ),
    resolvePaymentException: (exceptionId, input, requestOptions) =>
      request<PaymentException>(
        "POST",
        `/v1/exceptions/${pathId(exceptionId)}/resolve`,
        input,
        requestOptions,
        requestOptions.idempotencyKey,
      ),
    startPaymentExceptionInvestigation: (exceptionId, input, requestOptions) =>
      request<PaymentException>(
        "POST",
        `/v1/exceptions/${pathId(exceptionId)}/investigate`,
        input,
        requestOptions,
        requestOptions.idempotencyKey,
      ),
    escalatePaymentException: (exceptionId, input, requestOptions) =>
      request<PaymentException>(
        "POST",
        `/v1/exceptions/${pathId(exceptionId)}/escalate`,
        input,
        requestOptions,
        requestOptions.idempotencyKey,
      ),
    reopenPaymentException: (exceptionId, input, requestOptions) =>
      request<PaymentException>(
        "POST",
        `/v1/exceptions/${pathId(exceptionId)}/reopen`,
        input,
        requestOptions,
        requestOptions.idempotencyKey,
      ),
    createEvidencePack: (input, requestOptions) =>
      request<EvidencePack>(
        "POST",
        "/v1/evidence-packs",
        input,
        requestOptions,
        requestOptions.idempotencyKey,
      ),
    downloadEvidencePack: (evidencePackId, format, requestOptions = {}) => {
      if (format !== "json" && format !== "pdf")
        throw new TypeError("invalid_evidence_format");
      return download(
        `/v1/evidence-packs/${pathId(evidencePackId)}?format=${format}`,
        format === "json" ? "application/json" : "application/pdf",
        requestOptions,
      ).then(({ bytes, headers }) => ({
        bytes,
        manifestDigest: requiredResponseHeader(
          headers,
          "x-payops-manifest-digest",
          /^[0-9a-f]{64}$/u,
        ),
        signature: requiredResponseHeader(
          headers,
          "x-payops-signature",
          /^[A-Za-z0-9_-]{86}$/u,
        ),
        signingKeyId: requiredResponseHeader(
          headers,
          "x-payops-signing-key-id",
          /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u,
        ),
      }));
    },
    getEvidencePackVerification: (evidencePackId, requestOptions = {}) =>
      request<EvidenceVerification>(
        "GET",
        `/v1/evidence-packs/${pathId(evidencePackId)}/verification`,
        undefined,
        requestOptions,
      ),
    createAccountingExport: (input, requestOptions) =>
      request<AccountingExport>(
        "POST",
        "/v1/exports",
        input,
        requestOptions,
        requestOptions.idempotencyKey,
      ),
    downloadAccountingExport: (exportId, requestOptions = {}) =>
      download(
        `/v1/exports/${pathId(exportId)}`,
        "text/csv",
        requestOptions,
      ).then(({ bytes, headers }) => ({
        bytes,
        contentDigest: requiredResponseHeader(
          headers,
          "x-payops-content-digest",
          /^[0-9a-f]{64}$/u,
        ),
      })),
    getProductionControl: (requestOptions = {}) =>
      request<ProductionControlView>(
        "GET",
        "/v1/operations/production-control",
        undefined,
        requestOptions,
      ),
    getOperationalHealth: (requestOptions = {}) =>
      request<OperationalHealthSnapshot>(
        "GET",
        "/v1/operations/health",
        undefined,
        requestOptions,
      ),
    listOperationalIncidents: (requestOptions = {}) =>
      request<Page<OperationalIncident>>(
        "GET",
        withQuery("/v1/operations/incidents", requestOptions, [
          "limit",
          "cursor",
          "state",
          "kind",
        ]),
        undefined,
        requestOptions,
      ),
    getOperationalIncidentHistory: (incidentId, requestOptions = {}) =>
      request<Page<OperationalIncidentEvent>>(
        "GET",
        withQuery(
          `/v1/operations/incidents/${pathId(incidentId)}/history`,
          requestOptions,
          ["limit", "cursor"],
        ),
        undefined,
        requestOptions,
      ),
    acknowledgeOperationalIncident: (incidentId, input, requestOptions) =>
      request<OperationalIncident>(
        "POST",
        `/v1/operations/incidents/${pathId(incidentId)}/acknowledge`,
        input,
        requestOptions,
        requestOptions.idempotencyKey,
        undefined,
        "session",
      ),
    resolveOperationalIncident: (incidentId, input, requestOptions) =>
      request<OperationalIncident>(
        "POST",
        `/v1/operations/incidents/${pathId(incidentId)}/resolve`,
        input,
        requestOptions,
        requestOptions.idempotencyKey,
        undefined,
        "session",
      ),
    promoteProductionLive: (input, requestOptions) =>
      request<ProductionPromotionResult>(
        "POST",
        "/v1/operations/production-control/promote",
        input,
        requestOptions,
        requestOptions.idempotencyKey,
        isBlockedPromotion,
        "session",
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

function exactSessionOrigin(value: string): string {
  try {
    return exactHttpsOrigin(value);
  } catch {
    throw new TypeError("invalid_session_origin");
  }
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
    readonly state?: unknown;
    readonly kind?: unknown;
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
  if (keys.includes("kind")) {
    if (
      candidate.state !== undefined &&
      !["open", "acknowledged", "resolved"].includes(String(candidate.state))
    )
      throw new TypeError("invalid_operational_incident_state");
    if (
      candidate.kind !== undefined &&
      ![
        "rpc_disagreement",
        "ingestion_gap",
        "worker_stale",
        "ledger_mismatch",
        "webhook_dead_letter",
      ].includes(String(candidate.kind))
    )
      throw new TypeError("invalid_operational_incident_kind");
  } else if (
    candidate.state !== undefined &&
    ![
      "open",
      "assigned",
      "investigating",
      "escalated",
      "resolved",
      "ignored",
    ].includes(String(candidate.state))
  ) {
    throw new TypeError("invalid_exception_state");
  }
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

function requiredResponseHeader(
  headers: Headers,
  name: string,
  pattern: RegExp,
): string {
  const value = headers.get(name);
  if (value === null || !pattern.test(value)) {
    throw new PayOpsApiError({
      status: 200,
      code: "invalid_api_response",
      message: "PayOps API returned invalid artifact metadata",
      requestId: headers.get("x-request-id"),
    });
  }
  return value;
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

async function boundedBytes(
  response: Response,
  maximum: number,
): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > maximum)
  ) {
    await response.body?.cancel();
    throw responseTooLarge(response);
  }
  const reader = response.body?.getReader();
  if (reader === undefined) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > maximum) {
        await reader.cancel();
        throw responseTooLarge(response);
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
  return bytes;
}

function responseTooLarge(response: Response): PayOpsApiError {
  return new PayOpsApiError({
    status: response.status,
    code: "response_too_large",
    message: "PayOps API response exceeded the size limit",
    requestId: response.headers.get("x-request-id"),
  });
}

function invalidApiResponse(response: Response): PayOpsApiError {
  return new PayOpsApiError({
    status: response.status,
    code: "invalid_api_response",
    message: "PayOps API returned an invalid response",
    requestId: response.headers.get("x-request-id"),
  });
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

function validSessionCookie(value: string): boolean {
  return (
    value.length <= 4_096 &&
    /^(?:__Secure-)?payops\.session_token=[\x21-\x3a\x3c-\x7e]+$/u.test(value)
  );
}

function validUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );
}

function isBlockedPromotion(status: number, value: unknown): boolean {
  if (status !== 409 || value === null || typeof value !== "object")
    return false;
  const record = value as Record<string, unknown>;
  return (
    record.outcome === "blocked" &&
    record.status !== null &&
    typeof record.status === "object" &&
    record.evaluation !== null &&
    typeof record.evaluation === "object"
  );
}

type _GeneratedOperationsContract = operations;
