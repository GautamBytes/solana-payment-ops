import type { FastifyInstance, FastifyRequest } from "fastify";
import { safeStatusClass } from "../observability/logger.js";
import { requestIdFor } from "./request-context.js";

const apiErrorBrand = Symbol("payops.api-error");

export interface ApiErrorDetails {
  readonly [key: string]: string | number | boolean | null;
}

export class ApiError extends Error {
  public readonly code: string;
  public readonly status: number;
  public readonly details: ApiErrorDetails | undefined;

  public constructor(
    status: number,
    code: string,
    message: string,
    details?: ApiErrorDetails,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    Object.defineProperty(this, apiErrorBrand, { value: true });
  }
}

export function installErrorHandler(server: FastifyInstance): void {
  server.setErrorHandler(async (error, request, reply) => {
    const mapped = mapError(error, request);
    const fields = {
      event:
        mapped.status >= 500 ? "api_request_failed" : "api_request_rejected",
      requestId: requestIdFor(request),
      route: request.routeOptions.url,
      statusClass: safeStatusClass(mapped.status),
      code: mapped.code,
    };
    if (mapped.status >= 500) request.log.error(fields);
    else request.log.warn(fields);
    return reply.code(mapped.status).send(mapped.body);
  });

  server.setNotFoundHandler(async (request, reply) =>
    reply
      .code(404)
      .send(errorBody(request, "not_found", "Resource was not found")),
  );
}

function mapError(
  error: unknown,
  request: FastifyRequest,
): { readonly status: number; readonly code: string; readonly body: object } {
  const apiError = safeApiError(error);
  if (apiError !== null) {
    return {
      status: apiError.status,
      code: apiError.code,
      body: errorBody(
        request,
        apiError.code,
        apiError.message,
        apiError.details,
      ),
    };
  }
  const code = safeFastifyCode(error);
  if (code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") {
    return {
      status: 415,
      code: "unsupported_media_type",
      body: errorBody(
        request,
        "unsupported_media_type",
        "Content-Type must be application/json",
      ),
    };
  }
  if (code === "FST_ERR_CTP_BODY_TOO_LARGE") {
    return {
      status: 413,
      code: "body_too_large",
      body: errorBody(request, "body_too_large", "Request body is too large"),
    };
  }
  return {
    status: 500,
    code: "internal_error",
    body: errorBody(request, "internal_error", "An internal error occurred"),
  };
}

function safeApiError(error: unknown): {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly details?: ApiErrorDetails;
} | null {
  if (
    error === null ||
    (typeof error !== "object" && typeof error !== "function")
  )
    return null;
  try {
    if (Object.getOwnPropertyDescriptor(error, apiErrorBrand)?.value !== true)
      return null;
    const status = Object.getOwnPropertyDescriptor(error, "status")?.value;
    const code = Object.getOwnPropertyDescriptor(error, "code")?.value;
    const message = Object.getOwnPropertyDescriptor(error, "message")?.value;
    const details = Object.getOwnPropertyDescriptor(error, "details")?.value;
    const safeDetailsValue = sanitizeDetails(details);
    if (
      !Number.isSafeInteger(status) ||
      status < 400 ||
      status > 599 ||
      typeof code !== "string" ||
      !/^[a-z][a-z0-9_.-]{0,127}$/.test(code) ||
      typeof message !== "string" ||
      message.length < 1 ||
      message.length > 256 ||
      safeDetailsValue === null
    )
      return null;
    return {
      status,
      code,
      message,
      ...(safeDetailsValue === undefined ? {} : { details: safeDetailsValue }),
    };
  } catch {
    return null;
  }
}

function sanitizeDetails(value: unknown): ApiErrorDetails | undefined | null {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return null;
  try {
    const keys = Object.keys(value);
    if (keys.length > 32) return null;
    const output: Record<string, string | number | boolean | null> = {};
    for (const key of keys) {
      if (key.length < 1 || key.length > 128) return null;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) return null;
      const item = descriptor.value as unknown;
      if (
        item !== null &&
        typeof item !== "boolean" &&
        !(typeof item === "number" && Number.isFinite(item)) &&
        !(typeof item === "string" && item.length <= 1_024)
      )
        return null;
      output[key] = item as string | number | boolean | null;
    }
    return Object.freeze(output);
  } catch {
    return null;
  }
}

export function errorBody(
  request: FastifyRequest,
  code: string,
  message: string,
  details?: ApiErrorDetails,
): object {
  return {
    code,
    message,
    requestId: requestIdFor(request),
    ...(details === undefined ? {} : { details }),
  };
}

function safeFastifyCode(error: unknown): string | undefined {
  if (
    error === null ||
    (typeof error !== "object" && typeof error !== "function")
  ) {
    return undefined;
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, "code");
    return descriptor !== undefined &&
      "value" in descriptor &&
      typeof descriptor.value === "string"
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}
