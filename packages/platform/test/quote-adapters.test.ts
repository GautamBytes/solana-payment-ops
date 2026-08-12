import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  CommercialFiatRateAdapter,
  EcbReferenceRateAdapter,
  PythHermesPriceAdapter,
  QuoteProviderError,
} from "../src/index.js";

const feedId = "a".repeat(64);

describe("Pyth Hermes price adapter", () => {
  it("parses one exact requested feed without floating-point conversion", async () => {
    const body = {
      binary: { encoding: "hex", data: ["00"] },
      parsed: [
        {
          id: feedId,
          price: {
            price: "100012345",
            conf: "12345",
            expo: -8,
            publish_time: 1786535985,
          },
          ema_price: {
            price: "100000000",
            conf: "10000",
            expo: -8,
            publish_time: 1786535985,
          },
          metadata: {
            slot: 1,
            proof_available_time: 1786535986,
            prev_publish_time: 1786535984,
          },
        },
      ],
    };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse(body));
    const adapter = new PythHermesPriceAdapter(
      {
        endpoint: "https://pyth.example/hermes",
        accessToken: "provider-secret",
        feeds: { USDC: feedId, USDT: "b".repeat(64) },
      },
      { fetch, now: () => new Date("2026-08-12T12:00:00.000Z") },
    );

    await expect(
      adapter.observe("USDC", new AbortController().signal),
    ).resolves.toEqual({
      source: "pyth_hermes",
      symbol: "USDC",
      price: "1.00012345",
      confidence: "0.00012345",
      exponent: -8,
      publishTime: "2026-08-12T11:59:45.000Z",
      feedId,
      receivedAt: "2026-08-12T12:00:00.000Z",
      rawResponseDigest: digest(JSON.stringify(body)),
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe(
      `https://pyth.example/hermes/v2/updates/price/latest?ids%5B%5D=${feedId}&parsed=true&encoding=hex`,
    );
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer provider-secret",
    );
    expect(init?.redirect).toBe("manual");
  });

  it.each([
    ["duplicate", { parsed: [pythRow(), pythRow()] }],
    ["wrong feed", { parsed: [pythRow({ id: "c".repeat(64) })] }],
    ["extra field", { parsed: [{ ...pythRow(), unexpected: true }] }],
    [
      "bad integer",
      { parsed: [pythRow({ price: { ...pythRow().price, price: "1e8" } })] },
    ],
    [
      "bad exponent",
      { parsed: [pythRow({ price: { ...pythRow().price, expo: -19 } })] },
    ],
  ])("fails closed for %s responses", async (_name, body) => {
    const adapter = pythAdapter(vi.fn().mockResolvedValue(jsonResponse(body)));
    await expect(
      adapter.observe("USDC", new AbortController().signal),
    ).rejects.toMatchObject({ code: "rate_provider_invalid_response" });
  });

  it("bounds responses, disables redirects, honors cancellation, and redacts credentials", async () => {
    const oversized = pythAdapter(
      vi
        .fn()
        .mockResolvedValue(
          new Response("x".repeat(256 * 1024 + 1), { status: 200 }),
        ),
    );
    await expect(
      oversized.observe("USDC", new AbortController().signal),
    ).rejects.toMatchObject({ code: "rate_provider_response_too_large" });

    const redirected = pythAdapter(
      vi.fn().mockResolvedValue(new Response(null, { status: 302 })),
    );
    await expect(
      redirected.observe("USDC", new AbortController().signal),
    ).rejects.toMatchObject({ code: "rate_provider_unavailable" });

    const controller = new AbortController();
    controller.abort();
    const cancelled = pythAdapter(vi.fn());
    const failure = await cancelled
      .observe("USDC", controller.signal)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(QuoteProviderError);
    expect(String(failure)).not.toContain("provider-secret");
  });
});

describe("ECB reference rate adapter", () => {
  it("parses one latest complete official daily observation", async () => {
    const body = [
      "KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE",
      "EXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,2026-08-11,1.1726",
      "EXR.D.GBP.EUR.SP00.A,D,GBP,EUR,SP00,A,2026-08-11,0.86418",
      "EXR.D.INR.EUR.SP00.A,D,INR,EUR,SP00,A,2026-08-11,102.54",
    ].join("\n");
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(csvResponse(body));
    const adapter = new EcbReferenceRateAdapter(
      { endpoint: "https://data.example/service" },
      {
        fetch,
        now: () => new Date("2026-08-12T12:00:00.000Z"),
        publicationTime: () => new Date("2026-08-11T15:00:00.000Z"),
      },
    );

    await expect(
      adapter.observe("GBP", new AbortController().signal),
    ).resolves.toEqual({
      source: "ecb_reference",
      base: "EUR",
      rates: { USD: "1.1726", GBP: "0.86418", INR: "102.54" },
      observedFor: "2026-08-11",
      publishedAt: "2026-08-11T15:00:00.000Z",
      receivedAt: "2026-08-12T12:00:00.000Z",
      usage: "reference_only",
      rawResponseDigest: digest(body),
    });
    expect(String(fetch.mock.calls[0]?.[0])).toContain(
      "/data/EXR/D.USD+GBP+INR.EUR.SP00.A",
    );
  });

  it.each([
    ["missing USD", ["GBP,0.86", "INR,100"]],
    ["duplicate", ["USD,1.1", "USD,1.2", "GBP,0.86", "INR,100"]],
    ["unknown currency", ["USD,1.1", "GBP,0.86", "INR,100", "JPY,170"]],
    ["zero rate", ["USD,1.1", "GBP,0.86", "INR,0"]],
  ])("rejects %s data", async (_name, values) => {
    const rows = values.map(
      (entry) =>
        `EXR.D.${entry.split(",")[0]}.EUR.SP00.A,D,${entry.split(",")[0]},EUR,SP00,A,2026-08-11,${entry.split(",")[1]}`,
    );
    const adapter = ecbAdapter(
      vi
        .fn()
        .mockResolvedValue(
          csvResponse(
            [
              "KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE",
              ...rows,
            ].join("\n"),
          ),
        ),
    );
    await expect(
      adapter.observe("EUR", new AbortController().signal),
    ).rejects.toMatchObject({ code: "rate_provider_invalid_response" });
  });
});

describe("commercial fiat rate adapter", () => {
  it("parses one authenticated production-live observation", async () => {
    const body = {
      schemaVersion: "0.1",
      source: "secondary_commercial",
      base: "EUR",
      rates: { USD: "1.1726", GBP: "0.86418", INR: "102.54" },
      observedFor: "2026-08-12",
      publishedAt: "2026-08-12T11:59:30.000Z",
    };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse(body));
    const adapter = new CommercialFiatRateAdapter(
      {
        endpoint: "https://fx.example/v1/latest",
        accessToken: "commercial-provider-token",
      },
      { fetch, now: () => new Date("2026-08-12T12:00:00.000Z") },
    );

    await expect(
      adapter.observe("INR", new AbortController().signal),
    ).resolves.toEqual({
      source: "secondary_commercial",
      base: "EUR",
      rates: { USD: "1.1726", GBP: "0.86418", INR: "102.54" },
      observedFor: "2026-08-12",
      publishedAt: "2026-08-12T11:59:30.000Z",
      receivedAt: "2026-08-12T12:00:00.000Z",
      usage: "production_live",
      rawResponseDigest: digest(JSON.stringify(body)),
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("https://fx.example/v1/latest");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer commercial-provider-token",
    );
    expect(init?.redirect).toBe("manual");
  });

  it.each([
    ["extra key", { unexpected: true }],
    ["wrong source", { source: "ecb_reference" }],
    ["missing cross", { rates: { USD: "1.1", GBP: "0.8" } }],
    ["future date", { publishedAt: "not-a-time" }],
  ])("fails closed for %s", async (_name, override) => {
    const body = {
      schemaVersion: "0.1",
      source: "secondary_commercial",
      base: "EUR",
      rates: { USD: "1.1726", GBP: "0.86418", INR: "102.54" },
      observedFor: "2026-08-12",
      publishedAt: "2026-08-12T11:59:30.000Z",
      ...override,
    };
    const adapter = new CommercialFiatRateAdapter(
      {
        endpoint: "https://fx.example/v1/latest",
        accessToken: "commercial-provider-token",
      },
      {
        fetch: vi.fn().mockResolvedValue(jsonResponse(body)),
        now: () => new Date("2026-08-12T12:00:00.000Z"),
      },
    );
    await expect(
      adapter.observe("INR", new AbortController().signal),
    ).rejects.toMatchObject({ code: "rate_provider_invalid_response" });
  });
});

function pythAdapter(fetch: typeof globalThis.fetch): PythHermesPriceAdapter {
  return new PythHermesPriceAdapter(
    {
      endpoint: "https://pyth.example/hermes",
      accessToken: "provider-secret",
      feeds: { USDC: feedId, USDT: "b".repeat(64) },
    },
    { fetch, now: () => new Date("2026-08-12T12:00:00.000Z") },
  );
}

function ecbAdapter(fetch: typeof globalThis.fetch): EcbReferenceRateAdapter {
  return new EcbReferenceRateAdapter(
    { endpoint: "https://data.example/service" },
    {
      fetch,
      now: () => new Date("2026-08-12T12:00:00.000Z"),
      publicationTime: () => new Date("2026-08-11T15:00:00.000Z"),
    },
  );
}

function pythRow(overrides: Record<string, unknown> = {}) {
  return {
    id: feedId,
    price: {
      price: "100000000",
      conf: "10000",
      expo: -8,
      publish_time: 1786535985,
    },
    ema_price: {
      price: "100000000",
      conf: "10000",
      expo: -8,
      publish_time: 1786535985,
    },
    metadata: {
      slot: 1,
      proof_available_time: 1786535986,
      prev_publish_time: 1786535984,
    },
    ...overrides,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function csvResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/csv" },
  });
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
