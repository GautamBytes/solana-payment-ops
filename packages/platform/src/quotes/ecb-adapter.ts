import { createHash } from "node:crypto";
import {
  exactProviderBaseUrl,
  providerGet,
  QuoteProviderError,
  type ProviderHttpDependencies,
} from "./provider-http.js";
import type { FiatObservation, FiatRatePort } from "./types.js";

const header =
  "KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE";
const decimalPattern = /^(0|[1-9][0-9]{0,37})(\.[0-9]{1,18})?$/;

export class EcbReferenceRateAdapter implements FiatRatePort {
  readonly #endpoint: URL;
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => Date;
  readonly #publicationTime: (observedFor: string) => Date;

  public constructor(
    options: { readonly endpoint: string },
    dependencies: ProviderHttpDependencies & {
      readonly publicationTime?: (observedFor: string) => Date;
    } = {},
  ) {
    this.#endpoint = exactProviderBaseUrl(options.endpoint);
    this.#fetch = dependencies.fetch ?? fetch;
    this.#now = dependencies.now ?? (() => new Date());
    this.#publicationTime =
      dependencies.publicationTime ??
      ((observedFor) => new Date(`${observedFor}T15:00:00.000Z`));
  }

  public async observe(
    currency: "EUR" | "GBP" | "INR",
    signal: AbortSignal,
  ): Promise<FiatObservation> {
    if (!(["EUR", "GBP", "INR"] as const).includes(currency)) invalidResponse();
    const url = new URL(this.#endpoint);
    url.pathname = `${url.pathname}/data/EXR/D.USD+GBP+INR.EUR.SP00.A`;
    url.searchParams.set("lastNObservations", "1");
    url.searchParams.set("detail", "dataonly");
    url.searchParams.set("format", "csvdata");
    const response = await providerGet(
      url,
      { accept: "text/csv" },
      signal,
      this.#fetch,
    );
    const contentType = response.contentType.toLowerCase();
    if (
      !contentType.includes("text/csv") &&
      !contentType.includes("application/vnd.ecb.data+csv")
    )
      invalidResponse();
    const lines = response.body.replace(/\r\n/g, "\n").split("\n");
    if (lines.at(-1) === "") lines.pop();
    if (lines[0] !== header || lines.length !== 4) invalidResponse();
    const rates: Partial<Record<"USD" | "GBP" | "INR", string>> = {};
    let observedFor: string | undefined;
    for (const line of lines.slice(1)) {
      const fields = line!.split(",");
      if (fields.length !== 8) invalidResponse();
      const key = fields[0]!;
      const frequency = fields[1]!;
      const symbol = fields[2]!;
      const base = fields[3]!;
      const type = fields[4]!;
      const suffix = fields[5]!;
      const date = fields[6]!;
      const value = fields[7]!;
      if (
        (symbol !== "USD" && symbol !== "GBP" && symbol !== "INR") ||
        key !== `EXR.D.${symbol}.EUR.SP00.A` ||
        frequency !== "D" ||
        base !== "EUR" ||
        type !== "SP00" ||
        suffix !== "A" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(date!) ||
        !validDateOnly(date!) ||
        !decimalPattern.test(value!) ||
        BigInt(value!.replace(".", "")) === 0n ||
        rates[symbol] !== undefined ||
        (observedFor !== undefined && observedFor !== date)
      ) {
        invalidResponse();
      }
      observedFor = date;
      rates[symbol] = value;
    }
    if (
      observedFor === undefined ||
      rates.USD === undefined ||
      rates.GBP === undefined ||
      rates.INR === undefined
    ) {
      invalidResponse();
    }
    const receivedAt = this.#now();
    const publishedAt = this.#publicationTime(observedFor);
    if (
      !Number.isFinite(receivedAt.getTime()) ||
      !Number.isFinite(publishedAt.getTime())
    ) {
      invalidResponse();
    }
    return {
      source: "ecb_reference",
      base: "EUR",
      rates: { USD: rates.USD, GBP: rates.GBP, INR: rates.INR },
      observedFor,
      publishedAt: publishedAt.toISOString(),
      receivedAt: receivedAt.toISOString(),
      usage: "reference_only",
      rawResponseDigest: createHash("sha256")
        .update(response.body, "utf8")
        .digest("hex"),
    };
  }
}

function validDateOnly(value: string): boolean {
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

function invalidResponse(): never {
  throw new QuoteProviderError("rate_provider_invalid_response");
}
