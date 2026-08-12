import { createHash } from "node:crypto";
import {
  exactProviderBaseUrl,
  providerGet,
  QuoteProviderError,
  type ProviderHttpDependencies,
} from "./provider-http.js";
import type { FiatObservation, FiatRatePort } from "./types.js";

const decimalPattern = /^(0|[1-9][0-9]{0,37})(\.[0-9]{1,18})?$/;

export class CommercialFiatRateAdapter implements FiatRatePort {
  readonly #endpoint: URL;
  readonly #accessToken: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => Date;

  public constructor(
    options: { readonly endpoint: string; readonly accessToken: string },
    dependencies: ProviderHttpDependencies = {},
  ) {
    this.#endpoint = exactProviderBaseUrl(options.endpoint);
    if (!/^[\x21-\x7e]{16,512}$/.test(options.accessToken)) invalidConfig();
    this.#accessToken = options.accessToken;
    this.#fetch = dependencies.fetch ?? fetch;
    this.#now = dependencies.now ?? (() => new Date());
  }

  public async observe(
    currency: "EUR" | "GBP" | "INR",
    signal: AbortSignal,
  ): Promise<FiatObservation> {
    if (!(["EUR", "GBP", "INR"] as const).includes(currency)) invalidResponse();
    const response = await providerGet(
      new URL(this.#endpoint),
      {
        accept: "application/json",
        authorization: `Bearer ${this.#accessToken}`,
      },
      signal,
      this.#fetch,
    );
    if (!response.contentType.toLowerCase().startsWith("application/json")) {
      invalidResponse();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.body);
    } catch {
      invalidResponse();
    }
    const root = record(parsed);
    if (
      Object.keys(root).sort().join(",") !==
        "base,observedFor,publishedAt,rates,schemaVersion,source" ||
      root.schemaVersion !== "0.1" ||
      root.source !== "secondary_commercial" ||
      root.base !== "EUR" ||
      typeof root.observedFor !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(root.observedFor) ||
      !validDateOnly(root.observedFor) ||
      !canonicalTimestamp(root.publishedAt)
    ) {
      invalidResponse();
    }
    const rates = record(root.rates);
    if (
      Object.keys(rates).sort().join(",") !== "GBP,INR,USD" ||
      !positiveDecimal(rates.USD) ||
      !positiveDecimal(rates.GBP) ||
      !positiveDecimal(rates.INR)
    ) {
      invalidResponse();
    }
    const receivedAt = this.#now();
    if (!Number.isFinite(receivedAt.getTime())) invalidResponse();
    return {
      source: "secondary_commercial",
      base: "EUR",
      rates: { USD: rates.USD, GBP: rates.GBP, INR: rates.INR },
      observedFor: root.observedFor,
      publishedAt: root.publishedAt,
      receivedAt: receivedAt.toISOString(),
      usage: "production_live",
      rawResponseDigest: createHash("sha256")
        .update(response.body, "utf8")
        .digest("hex"),
    };
  }
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalidResponse();
  }
  return value as Record<string, unknown>;
}

function positiveDecimal(value: unknown): value is string {
  return (
    typeof value === "string" &&
    decimalPattern.test(value) &&
    BigInt(value.replace(".", "")) > 0n
  );
}

function validDateOnly(value: string): boolean {
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function invalidConfig(): never {
  throw new QuoteProviderError("invalid_rate_provider_configuration");
}

function invalidResponse(): never {
  throw new QuoteProviderError("rate_provider_invalid_response");
}
