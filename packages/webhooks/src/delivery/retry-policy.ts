export type DeliveryResult =
  | { readonly kind: "response"; readonly status: number }
  | { readonly kind: "network_error"; readonly code: string };

export type DeliveryResultClass = "success" | "retry" | "dead";

export interface RetryScheduleOptions {
  readonly retryAfterMs?: number;
}

const initialDelayMs = 5_000;
const maximumDelayMs = 3_600_000;
const automaticRetryWindowMs = 72 * 60 * 60 * 1_000;

export function canAutomaticallySend(
  firstAttemptAt: Date,
  attempt: number,
  now: Date,
): boolean {
  assertScheduleInputs(firstAttemptAt, attempt, now);
  return now.getTime() < firstAttemptAt.getTime() + automaticRetryWindowMs;
}

export function classifyDeliveryResult(
  result: DeliveryResult,
): DeliveryResultClass {
  if (result.kind === "network_error") return "retry";
  if (result.status >= 200 && result.status < 300) return "success";
  if (
    result.status === 408 ||
    result.status === 425 ||
    result.status === 429 ||
    (result.status >= 500 && result.status <= 599)
  ) {
    return "retry";
  }
  return "dead";
}

export function nextAttemptAt(
  firstAttemptAt: Date,
  attempt: number,
  now: Date,
  random: () => number,
  options: RetryScheduleOptions = {},
): Date | null {
  assertScheduleInputs(firstAttemptAt, attempt, now);

  const retryCutoff = firstAttemptAt.getTime() + automaticRetryWindowMs;
  if (now.getTime() >= retryCutoff) return null;

  const randomValue = random();
  if (!Number.isFinite(randomValue) || randomValue < 0 || randomValue >= 1) {
    throw new TypeError("Random source must return a number from 0 up to 1");
  }

  const retryAfterMs = options.retryAfterMs ?? 0;
  if (!Number.isSafeInteger(retryAfterMs) || retryAfterMs < 0) {
    throw new TypeError("Retry-After delay must be a non-negative integer");
  }

  const exponentialDelay =
    attempt >= 12 ? maximumDelayMs : initialDelayMs * 2 ** (attempt - 1);
  const jitteredDelay = Math.floor(exponentialDelay * (0.5 + randomValue));
  const boundedDelay = Math.min(
    maximumDelayMs,
    Math.max(jitteredDelay, Math.min(retryAfterMs, maximumDelayMs)),
  );
  const scheduledAt = now.getTime() + boundedDelay;
  return scheduledAt < retryCutoff ? new Date(scheduledAt) : null;
}

function assertScheduleInputs(
  firstAttemptAt: Date,
  attempt: number,
  now: Date,
): void {
  assertValidDate(firstAttemptAt, "First-attempt time");
  assertValidDate(now, "Current time");
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new TypeError("Attempt must be a positive integer");
  }
}

function assertValidDate(value: Date, label: string): void {
  if (!Number.isFinite(value.getTime())) {
    throw new TypeError(`${label} must be a valid date`);
  }
}
