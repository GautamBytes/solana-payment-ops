import { signWebhook } from "../signing/hmac.js";
import type {
  ClaimedDelivery,
  ClaimDueDeliveriesInput,
  CompleteDeliveryInput,
} from "../storage/types.js";
import {
  canAutomaticallySend,
  classifyDeliveryResult,
  nextAttemptAt,
  type DeliveryResult,
} from "./retry-policy.js";

export interface DeliveryStore {
  claimDueDeliveries(
    input: ClaimDueDeliveriesInput,
  ): Promise<readonly ClaimedDelivery[]>;
  completeDelivery(input: CompleteDeliveryInput): Promise<boolean>;
}

export interface DeliveryTransportRequest {
  readonly url: string;
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface DeliveryTransportResponse {
  readonly status: number;
  readonly retryAfter?: string | null;
}

export interface DeliveryTransport {
  send(request: DeliveryTransportRequest): Promise<DeliveryTransportResponse>;
}

export type DeliveryEnvironment = Readonly<Record<string, string | undefined>>;

export interface DeliveryBatchOptions {
  readonly limit: number;
  readonly leaseMs: number;
  readonly now?: () => Date;
  readonly random?: () => number;
  readonly concurrency?: number;
}

export interface DeliveryBatchResult {
  readonly claimed: number;
  readonly succeeded: number;
  readonly retryScheduled: number;
  readonly dead: number;
  readonly leaseLost: number;
}

type DeliveryCompletion = Omit<
  CompleteDeliveryInput,
  "deliveryId" | "leaseToken"
>;

type CommittedOutcome = "succeeded" | "retryScheduled" | "dead" | "leaseLost";

export async function runDeliveryBatch(
  store: DeliveryStore,
  transport: DeliveryTransport,
  env: DeliveryEnvironment,
  options: DeliveryBatchOptions,
): Promise<DeliveryBatchResult> {
  const clock = options.now ?? (() => new Date());
  const random = options.random ?? Math.random;
  const concurrency = options.concurrency ?? Math.min(options.limit, 32);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    throw new TypeError("Delivery concurrency must be an integer from 1 to 32");
  }
  const claims = await store.claimDueDeliveries({
    now: clock(),
    limit: options.limit,
    leaseMs: options.leaseMs,
  });
  const outcomes = await mapConcurrent(
    claims,
    concurrency,
    async (claim): Promise<CommittedOutcome> => {
      const completion = await deliverClaim(
        claim,
        transport,
        env,
        clock,
        random,
      );
      const completed = await store.completeDelivery({
        deliveryId: claim.deliveryId,
        leaseToken: claim.leaseToken,
        ...completion,
      });
      if (!completed) return "leaseLost";
      return completion.state === "retry_wait"
        ? "retryScheduled"
        : completion.state;
    },
  );
  return outcomes.reduce<DeliveryBatchResult>(
    (counts, outcome) => ({
      ...counts,
      [outcome]: counts[outcome] + 1,
    }),
    {
      claimed: claims.length,
      succeeded: 0,
      retryScheduled: 0,
      dead: 0,
      leaseLost: 0,
    },
  );
}

async function deliverClaim(
  claim: ClaimedDelivery,
  transport: DeliveryTransport,
  env: DeliveryEnvironment,
  clock: () => Date,
  random: () => number,
): Promise<DeliveryCompletion> {
  const startedAt = clock();
  if (claim.manualReplayRecovery) {
    return terminalCompletion(
      startedAt,
      clock(),
      "manual_replay_lease_expired",
    );
  }
  if (
    !claim.manualReplay &&
    !canAutomaticallySend(claim.firstAttemptAt, claim.attemptNumber, startedAt)
  ) {
    return terminalCompletion(startedAt, clock(), "retry_exhausted");
  }
  const secret = Object.hasOwn(env, claim.endpoint.secretEnv)
    ? env[claim.endpoint.secretEnv]
    : undefined;
  if (secret === undefined || secret.length === 0) {
    return terminalCompletion(
      startedAt,
      clock(),
      secret === undefined ? "missing_secret" : "empty_secret",
    );
  }

  const timestamp = Math.floor(startedAt.getTime() / 1_000).toString();
  let response: DeliveryTransportResponse;
  try {
    response = await transport.send({
      url: claim.endpoint.url,
      body: claim.event.payload,
      headers: {
        "content-type": "application/json",
        "payops-delivery-id": claim.deliveryId,
        "payops-event-id": claim.event.id,
        "payops-signature": signWebhook(claim.event.payload, timestamp, secret),
        "payops-timestamp": timestamp,
      },
    });
  } catch (error) {
    const completedAt = clock();
    return resultCompletion(
      claim,
      { kind: "network_error", code: safeTransportErrorCode(error) },
      completedAt,
      elapsedMilliseconds(startedAt, completedAt),
      random,
    );
  }

  const completedAt = clock();
  if (!isHttpStatus(response.status)) {
    return resultCompletion(
      claim,
      { kind: "network_error", code: "invalid_response" },
      completedAt,
      elapsedMilliseconds(startedAt, completedAt),
      random,
    );
  }
  return resultCompletion(
    claim,
    { kind: "response", status: response.status },
    completedAt,
    elapsedMilliseconds(startedAt, completedAt),
    random,
    parseRetryAfter(response.retryAfter, completedAt),
  );
}

function resultCompletion(
  claim: ClaimedDelivery,
  result: DeliveryResult,
  completedAt: Date,
  durationMs: number,
  random: () => number,
  retryAfterMs?: number,
): DeliveryCompletion {
  const resultClass = classifyDeliveryResult(result);
  const httpStatus = result.kind === "response" ? result.status : null;
  if (resultClass === "success") {
    return {
      state: "succeeded",
      completedAt,
      nextAttemptAt: null,
      httpStatus,
      errorCode: null,
      durationMs,
    };
  }

  const errorCode =
    result.kind === "response" ? `http_${result.status}` : result.code;
  if (resultClass === "dead") {
    return {
      state: "dead",
      completedAt,
      nextAttemptAt: null,
      httpStatus,
      errorCode,
      durationMs,
    };
  }

  if (claim.manualReplay) {
    return {
      state: "dead",
      completedAt,
      nextAttemptAt: null,
      httpStatus,
      errorCode,
      durationMs,
    };
  }

  const scheduledAt = nextAttemptAt(
    claim.firstAttemptAt,
    claim.attemptNumber,
    completedAt,
    random,
    retryAfterMs === undefined ? undefined : { retryAfterMs },
  );
  return scheduledAt === null
    ? {
        state: "dead",
        completedAt,
        nextAttemptAt: null,
        httpStatus,
        errorCode: "retry_exhausted",
        durationMs,
      }
    : {
        state: "retry_wait",
        completedAt,
        nextAttemptAt: scheduledAt,
        httpStatus,
        errorCode,
        durationMs,
      };
}

function terminalCompletion(
  startedAt: Date,
  completedAt: Date,
  errorCode:
    | "missing_secret"
    | "empty_secret"
    | "retry_exhausted"
    | "manual_replay_lease_expired",
): DeliveryCompletion {
  return {
    state: "dead",
    completedAt,
    nextAttemptAt: null,
    httpStatus: null,
    errorCode,
    durationMs: elapsedMilliseconds(startedAt, completedAt),
  };
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<readonly R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  let failed = false;
  let firstError: unknown;
  async function worker(): Promise<void> {
    while (!failed && nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = await operation(values[index]!);
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
        }
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, worker),
  );
  if (failed) throw firstError;
  return results;
}

function parseRetryAfter(value: string | null | undefined, now: Date) {
  if (value === undefined || value === null) return undefined;
  if (/^(0|[1-9][0-9]*)$/.test(value)) {
    const seconds = Number(value);
    return Number.isSafeInteger(seconds) &&
      seconds <= Number.MAX_SAFE_INTEGER / 1_000
      ? seconds * 1_000
      : undefined;
  }
  const retryAt = Date.parse(value);
  if (!Number.isFinite(retryAt)) return undefined;
  return Math.max(0, retryAt - now.getTime());
}

function safeTransportErrorCode(error: unknown): string {
  let code = "";
  try {
    if (typeof error === "object" && error !== null && "code" in error) {
      const candidate = error.code;
      if (typeof candidate === "string") code = candidate;
    }
  } catch {
    return "network_error";
  }
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
    case "total_timeout":
    case "unsafe_endpoint":
      return code;
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
    case "PAYOPS_RESPONSE_TOO_LARGE":
      return "response_too_large";
    default:
      return code.startsWith("ERR_TLS_") || code.startsWith("CERT_")
        ? "tls_failed"
        : "network_error";
  }
}

function elapsedMilliseconds(startedAt: Date, completedAt: Date): number {
  return Math.min(
    2_147_483_647,
    Math.max(0, Math.floor(completedAt.getTime() - startedAt.getTime())),
  );
}

function isHttpStatus(value: number): boolean {
  return Number.isInteger(value) && value >= 100 && value <= 599;
}
