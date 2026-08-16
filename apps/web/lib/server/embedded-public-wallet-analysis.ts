import type {
  PublicWalletAnalysis,
  PublicWalletAnalysisInput,
  SolanaRpcPort,
} from "@payops/ingestion/public-analysis";
import {
  preparePublicWalletAnalysisRequest,
  PublicWalletRequestError,
} from "@payops/ingestion/public-analysis";
import {
  publicAnalysisStatusClass,
  type PublicAnalysisCompletion,
} from "./public-analysis-observability.js";

interface EmbeddedPublicWalletAnalysisDependencies {
  readonly isEnabled: () => boolean;
  readonly rpcForRequest: (signal: AbortSignal) => SolanaRpcPort;
  readonly analyze: (
    input: PublicWalletAnalysisInput,
    dependencies: {
      readonly rpc: SolanaRpcPort;
      readonly maxSignatures: number;
      readonly maxTransactions: number;
      readonly concurrency: number;
    },
  ) => Promise<PublicWalletAnalysis>;
  readonly now?: () => Date;
  readonly requestId?: () => string;
  readonly logCompleted?: (event: PublicAnalysisCompletion) => void;
}

const maximumBodyBytes = 2_048;
const responseHeaders = {
  "cache-control": "no-store",
  "content-type": "application/json",
  "x-content-type-options": "nosniff",
} as const;

export function createEmbeddedPublicWalletAnalysisHandler(
  dependencies: EmbeddedPublicWalletAnalysisDependencies,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const startedAt = performance.now();
    const requestId = dependencies.requestId?.() ?? crypto.randomUUID();
    const complete = (response: Response, code: string): Response => {
      try {
        dependencies.logCompleted?.({
          event: "public_analysis_request_completed",
          requestId,
          route: "/v1/public-wallet-analysis",
          statusClass: publicAnalysisStatusClass(response.status),
          durationMs: performance.now() - startedAt,
          code,
        });
      } catch {
        // Observability must never change the public response contract.
      }
      return response;
    };
    if (!dependencies.isEnabled()) {
      return complete(
        errorResponse(
          404,
          "public_analysis_disabled",
          "Public analysis is not available",
          requestId,
        ),
        "public_analysis_disabled",
      );
    }
    if (!isSameOrigin(request)) {
      return complete(
        errorResponse(
          403,
          "untrusted_origin",
          "Origin is not trusted",
          requestId,
        ),
        "untrusted_origin",
      );
    }
    if (!isJson(request.headers.get("content-type"))) {
      return complete(
        errorResponse(
          415,
          "unsupported_media_type",
          "Content type must be application/json",
          requestId,
        ),
        "unsupported_media_type",
      );
    }

    let body: unknown;
    try {
      body = await readBoundedJson(request);
    } catch (error) {
      const tooLarge =
        error instanceof EmbeddedRequestError &&
        error.code === "body_too_large";
      const code = tooLarge ? "request_body_too_large" : "invalid_json";
      return complete(
        errorResponse(
          tooLarge ? 413 : 400,
          code,
          tooLarge ? "Request body is too large" : "Request body is invalid",
          requestId,
        ),
        code,
      );
    }

    const now = dependencies.now?.() ?? new Date();
    let input: PublicWalletAnalysisInput;
    try {
      input = (await preparePublicWalletAnalysisRequest(body, now)).input;
    } catch (error) {
      const field =
        error instanceof PublicWalletRequestError
          ? error.field
          : "walletAddress";
      return complete(
        jsonResponse(
          {
            code: "invalid_public_analysis_request",
            message: "Public analysis request is invalid",
            requestId,
            details: { field },
          },
          400,
        ),
        "invalid_public_analysis_request",
      );
    }

    try {
      const signal = AbortSignal.any([
        request.signal,
        AbortSignal.timeout(20_000),
      ]);
      const analysis = await dependencies.analyze(input, {
        rpc: dependencies.rpcForRequest(signal),
        maxSignatures: 40,
        maxTransactions: 20,
        concurrency: 2,
      });
      return complete(jsonResponse(analysis, 200), "ok");
    } catch {
      return complete(
        errorResponse(
          503,
          "public_analysis_unavailable",
          "Public analysis is temporarily unavailable",
          requestId,
        ),
        "public_analysis_unavailable",
      );
    }
  };
}

function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin === null) return false;
  try {
    return (
      new URL(origin).origin === origin &&
      new URL(request.url).origin === origin
    );
  } catch {
    return false;
  }
}

function isJson(value: string | null): boolean {
  return (
    value !== null &&
    /^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(value)
  );
}

async function readBoundedJson(request: Request): Promise<unknown> {
  const contentLength = request.headers.get("content-length");
  if (
    contentLength !== null &&
    (!/^(0|[1-9][0-9]*)$/u.test(contentLength) ||
      Number(contentLength) > maximumBodyBytes)
  ) {
    throw new EmbeddedRequestError("body_too_large");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maximumBodyBytes) {
    throw new EmbeddedRequestError("body_too_large");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new EmbeddedRequestError("invalid_json");
  }
}

class EmbeddedRequestError extends Error {
  public constructor(readonly code: "body_too_large" | "invalid_json") {
    super("Embedded public analysis request is invalid");
  }
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  requestId: string,
): Response {
  return jsonResponse({ code, message, requestId }, status);
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: responseHeaders,
  });
}
