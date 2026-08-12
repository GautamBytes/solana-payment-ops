export type QuoteCurrency = "USD" | "EUR" | "GBP" | "INR";
export type QuoteAssetSymbol = "USDC" | "USDT";

export interface StablecoinObservation {
  readonly source: "pyth_hermes" | "secondary_test" | "secondary_commercial";
  readonly symbol: QuoteAssetSymbol;
  readonly price: string;
  readonly confidence: string;
  readonly exponent: number;
  readonly publishTime: string;
  readonly feedId: string;
  readonly receivedAt: string;
  readonly rawResponseDigest: string;
}

export interface FiatObservation {
  readonly source: "ecb_reference" | "secondary_commercial";
  readonly base: "EUR";
  readonly rates: Readonly<Record<"USD" | "GBP" | "INR", string>>;
  readonly observedFor: string;
  readonly publishedAt: string;
  readonly receivedAt: string;
  readonly usage: "reference_only" | "production_live";
  readonly rawResponseDigest: string;
}

export interface StablecoinPricePort {
  observe(
    symbol: QuoteAssetSymbol,
    signal: AbortSignal,
  ): Promise<StablecoinObservation>;
}

export interface FiatRatePort {
  observe(
    currency: Exclude<QuoteCurrency, "USD">,
    signal: AbortSignal,
  ): Promise<FiatObservation>;
}
