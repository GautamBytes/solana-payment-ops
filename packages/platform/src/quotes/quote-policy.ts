import {
  absoluteDifference,
  parseUnsignedDecimal,
  ratioAtMost,
} from "./exact-decimal.js";
import type {
  FiatObservation,
  QuoteCurrency,
  StablecoinObservation,
} from "./types.js";

export type QuotePolicyErrorCode =
  | "rate_unavailable"
  | "rate_stale"
  | "rate_low_confidence"
  | "stablecoin_depegged"
  | "rate_divergence"
  | "fx_reference_not_production"
  | "rate_invalid";

export class QuotePolicyError extends Error {
  public constructor(readonly code: QuotePolicyErrorCode) {
    super("Quote inputs rejected");
    this.name = "QuotePolicyError";
  }
}

export interface QuotePolicyInput {
  readonly now: Date;
  readonly environment: "production" | "test";
  readonly currency: QuoteCurrency;
  readonly primary: StablecoinObservation;
  readonly secondary?: StablecoinObservation | undefined;
  readonly requireSecondary?: boolean;
  readonly fiat?: FiatObservation | undefined;
}

export interface ValidatedQuoteInputs {
  readonly primary: StablecoinObservation;
  readonly fiat: FiatObservation | null;
}

export function evaluateQuoteInputs(
  input: QuotePolicyInput,
): ValidatedQuoteInputs {
  const nowMs = exactDate(input.now);
  validateStablecoin(input.primary, nowMs);
  if (input.requireSecondary && input.secondary === undefined) {
    throw new QuotePolicyError("rate_unavailable");
  }
  if (input.secondary !== undefined) {
    validateStablecoin(input.secondary, nowMs);
    if (input.secondary.symbol !== input.primary.symbol) invalid();
    const primary = decimal(input.primary.price, false);
    const divergence = absoluteDifference(
      primary,
      decimal(input.secondary.price, false),
    );
    if (!ratioAtMost(divergence, primary, 5n, 1_000n)) {
      throw new QuotePolicyError("rate_divergence");
    }
  }
  if (input.currency === "USD") {
    return { primary: input.primary, fiat: null };
  }
  if (input.fiat === undefined) throw new QuotePolicyError("rate_unavailable");
  validateFiat(input.fiat, nowMs);
  if (
    input.environment === "production" &&
    (input.fiat.source !== "secondary_commercial" ||
      input.fiat.usage !== "production_live")
  ) {
    throw new QuotePolicyError("fx_reference_not_production");
  }
  return { primary: input.primary, fiat: input.fiat };
}

function validateStablecoin(
  observation: StablecoinObservation,
  nowMs: number,
): void {
  if (
    !["pyth_hermes", "secondary_test", "secondary_commercial"].includes(
      observation.source,
    ) ||
    !["USDC", "USDT"].includes(observation.symbol) ||
    !Number.isSafeInteger(observation.exponent) ||
    observation.exponent < -18 ||
    observation.exponent > 18 ||
    !/^[0-9a-f]{64}$/.test(observation.feedId) ||
    !/^[0-9a-f]{64}$/.test(observation.rawResponseDigest)
  ) {
    invalid();
  }
  const publishMs = exactTimestamp(observation.publishTime);
  const receivedMs = exactTimestamp(observation.receivedAt);
  if (
    receivedMs < publishMs ||
    receivedMs > nowMs + 5_000 ||
    publishMs > nowMs + 5_000
  )
    invalid();
  if (nowMs - publishMs > 30_000) throw new QuotePolicyError("rate_stale");
  const price = decimal(observation.price, false);
  const confidence = decimal(observation.confidence, true);
  if (!ratioAtMost(confidence, price, 5n, 1_000n)) {
    throw new QuotePolicyError("rate_low_confidence");
  }
  const deviation = absoluteDifference(price, decimal("1", false));
  if (!ratioAtMost(deviation, decimal("1", false), 1n, 100n)) {
    throw new QuotePolicyError("stablecoin_depegged");
  }
}

function validateFiat(observation: FiatObservation, nowMs: number): void {
  if (
    !["ecb_reference", "secondary_commercial"].includes(observation.source) ||
    observation.base !== "EUR" ||
    !["reference_only", "production_live"].includes(observation.usage) ||
    !/^[0-9a-f]{64}$/.test(observation.rawResponseDigest) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(observation.observedFor) ||
    Object.keys(observation.rates).sort().join(",") !== "GBP,INR,USD"
  ) {
    invalid();
  }
  decimal(observation.rates.USD, false);
  decimal(observation.rates.GBP, false);
  decimal(observation.rates.INR, false);
  const publishedMs = exactTimestamp(observation.publishedAt);
  const receivedMs = exactTimestamp(observation.receivedAt);
  if (
    receivedMs < publishedMs ||
    publishedMs > nowMs + 5_000 ||
    receivedMs > nowMs + 5_000
  )
    invalid();
  const maximumAge =
    observation.usage === "production_live" ? 5 * 60_000 : 36 * 60 * 60_000;
  if (nowMs - publishedMs > maximumAge)
    throw new QuotePolicyError("rate_stale");
}

function decimal(value: string, allowZero: boolean) {
  try {
    return parseUnsignedDecimal(value, allowZero);
  } catch {
    invalid();
  }
}

function exactTimestamp(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    invalid();
  }
  return parsed;
}

function exactDate(value: Date): number {
  const parsed = value.getTime();
  if (!Number.isFinite(parsed)) invalid();
  return parsed;
}

function invalid(): never {
  throw new QuotePolicyError("rate_invalid");
}
