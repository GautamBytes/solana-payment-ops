import { createHash } from "node:crypto";
import { decimalFromIntegerExponent } from "./exact-decimal.js";
import {
  exactProviderBaseUrl,
  providerGet,
  QuoteProviderError,
  type ProviderHttpDependencies,
} from "./provider-http.js";
import type {
  QuoteAssetSymbol,
  StablecoinObservation,
  StablecoinPricePort,
} from "./types.js";

const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");

export class PythHermesPriceAdapter implements StablecoinPricePort {
  readonly #endpoint: URL;
  readonly #accessToken: string;
  readonly #feeds: Readonly<Record<QuoteAssetSymbol, string>>;
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => Date;

  public constructor(
    options: {
      readonly endpoint: string;
      readonly accessToken: string;
      readonly feeds: Readonly<Record<QuoteAssetSymbol, string>>;
    },
    dependencies: ProviderHttpDependencies = {},
  ) {
    this.#endpoint = exactProviderBaseUrl(options.endpoint);
    if (!/^[\x21-\x7e]{1,512}$/.test(options.accessToken)) invalidConfig();
    if (
      !/^[0-9a-f]{64}$/.test(options.feeds.USDC) ||
      !/^[0-9a-f]{64}$/.test(options.feeds.USDT) ||
      options.feeds.USDC === options.feeds.USDT
    ) {
      invalidConfig();
    }
    this.#accessToken = options.accessToken;
    this.#feeds = Object.freeze({ ...options.feeds });
    this.#fetch = dependencies.fetch ?? fetch;
    this.#now = dependencies.now ?? (() => new Date());
  }

  public async observe(
    symbol: QuoteAssetSymbol,
    signal: AbortSignal,
  ): Promise<StablecoinObservation> {
    if (symbol !== "USDC" && symbol !== "USDT") invalidResponse();
    const feedId = this.#feeds[symbol];
    const url = new URL(this.#endpoint);
    url.pathname = `${url.pathname}/v2/updates/price/latest`;
    url.searchParams.set("ids[]", feedId);
    url.searchParams.set("parsed", "true");
    url.searchParams.set("encoding", "hex");
    const response = await providerGet(
      url,
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
    if (!exactKeys(root, ["binary", "parsed"])) invalidResponse();
    validateBinary(record(root.binary));
    if (!Array.isArray(root.parsed) || root.parsed.length !== 1)
      invalidResponse();
    const row = record(root.parsed[0]);
    if (!exactKeys(row, ["id", "price", "ema_price", "metadata"]))
      invalidResponse();
    if (row.id !== feedId) invalidResponse();
    validatePrice(record(row.ema_price));
    validateMetadata(record(row.metadata));
    const price = validatePrice(record(row.price));
    const now = this.#now();
    if (!Number.isFinite(now.getTime())) invalidResponse();
    let canonicalPrice: string;
    let canonicalConfidence: string;
    try {
      canonicalPrice = decimalFromIntegerExponent(
        price.price,
        price.exponent,
        false,
      );
      canonicalConfidence = decimalFromIntegerExponent(
        price.confidence,
        price.exponent,
        true,
      );
    } catch {
      invalidResponse();
    }
    return {
      source: "pyth_hermes",
      symbol,
      price: canonicalPrice,
      confidence: canonicalConfidence,
      exponent: price.exponent,
      publishTime: new Date(price.publishTime * 1_000).toISOString(),
      feedId,
      receivedAt: now.toISOString(),
      rawResponseDigest: createHash("sha256")
        .update(response.body, "utf8")
        .digest("hex"),
    };
  }
}

function validateBinary(value: Record<string, unknown>): void {
  const data = Array.isArray(value.data) ? value.data[0] : undefined;
  if (
    !exactKeys(value, ["encoding", "data"]) ||
    (value.encoding !== "hex" && value.encoding !== "base64") ||
    !Array.isArray(value.data) ||
    value.data.length !== 1 ||
    typeof data !== "string" ||
    data.length > 196_608 ||
    (value.encoding === "hex" &&
      (data.length % 2 !== 0 || !/^[0-9a-f]+$/.test(data))) ||
    (value.encoding === "base64" && !/^[A-Za-z0-9+/]+={0,2}$/.test(data))
  ) {
    invalidResponse();
  }
}

function validatePrice(value: Record<string, unknown>): {
  price: string;
  confidence: string;
  exponent: number;
  publishTime: number;
} {
  if (!exactKeys(value, ["price", "conf", "expo", "publish_time"]))
    invalidResponse();
  if (
    typeof value.price !== "string" ||
    typeof value.conf !== "string" ||
    !/^-?(0|[1-9][0-9]{0,18})$/.test(value.price) ||
    !/^(0|[1-9][0-9]{0,19})$/.test(value.conf) ||
    !Number.isSafeInteger(value.expo) ||
    (value.expo as number) < -18 ||
    (value.expo as number) > 18 ||
    !Number.isSafeInteger(value.publish_time) ||
    (value.publish_time as number) < 0 ||
    (value.publish_time as number) > 253_402_300_799
  ) {
    invalidResponse();
  }
  return {
    price: value.price,
    confidence: value.conf,
    exponent: value.expo as number,
    publishTime: value.publish_time as number,
  };
}

function validateMetadata(value: Record<string, unknown>): void {
  if (
    !exactKeys(value, ["slot", "proof_available_time", "prev_publish_time"]) ||
    !Number.isSafeInteger(value.slot) ||
    (value.slot as number) < 0 ||
    !Number.isSafeInteger(value.proof_available_time) ||
    (value.proof_available_time as number) < 0 ||
    !Number.isSafeInteger(value.prev_publish_time) ||
    (value.prev_publish_time as number) < 0
  ) {
    invalidResponse();
  }
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    invalidResponse();
  return value as Record<string, unknown>;
}

function invalidConfig(): never {
  throw new QuoteProviderError("invalid_rate_provider_configuration");
}

function invalidResponse(): never {
  throw new QuoteProviderError("rate_provider_invalid_response");
}
