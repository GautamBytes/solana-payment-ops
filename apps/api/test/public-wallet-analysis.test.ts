import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { installErrorHandler } from "../src/protocol/api-error.js";
import { installRequestContext } from "../src/protocol/request-context.js";
import { registerPublicWalletAnalysisRoutes } from "../src/routes/public-wallet-analysis.js";

const walletAddress = "LcNR2RPX9mMG1a23dfG6yQNvLUctx4sniKXKH9TV3ym";
const origin = "https://pay.example";
const validRequest = {
  method: "POST" as const,
  url: "/v1/public/wallet-analysis",
  headers: { origin, "content-type": "application/json" },
  payload: { walletAddress, rangeDays: 7 },
};

const servers: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function createFixture() {
  const server = Fastify();
  servers.push(server);
  installRequestContext(server);
  installErrorHandler(server);
  const analyze = vi.fn(async () => ({
    schemaVersion: "0.1" as const,
    walletAddress,
    fromTime: "2026-08-09T00:00:00.000Z",
    throughTime: "2026-08-16T00:00:00.000Z",
    coverage: "partial" as const,
    transfers: [],
  }));
  const rateLimits = {
    consume: vi.fn(async () => ({
      allowed: true,
      limit: 5,
      remaining: 4,
      retryAfterSeconds: 60,
    })),
  };
  const rpcForRequest = vi.fn(() => ({
    getSignaturesForAddress: vi.fn(async () => []),
    getTransaction: vi.fn(async () => null),
    getSignatureStatuses: vi.fn(async () => []),
    getSlot: vi.fn(async () => 0n),
  }));

  registerPublicWalletAnalysisRoutes(server, {
    trustedOrigins: [origin],
    clientDigestSecret: Buffer.alloc(32, 7).toString("base64url"),
    rateLimits,
    rpcForRequest,
    analyze,
    now: () => new Date("2026-08-16T00:00:00.000Z"),
  });
  return { server, analyze, rateLimits, rpcForRequest };
}

describe("public wallet analysis routes", () => {
  it("requires a trusted origin but no session and preserves partial coverage", async () => {
    const fixture = createFixture();
    const response = await fixture.server.inject(validRequest);

    expect(response.statusCode).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe(origin);
    expect(response.headers.vary).toContain("Origin");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toMatchObject({ coverage: "partial" });
    expect(fixture.analyze).toHaveBeenCalledOnce();
    expect(fixture.analyze).toHaveBeenCalledWith(
      expect.objectContaining({
        walletAddress,
        watchedTokenAccounts: [
          expect.objectContaining({ assetSymbol: "USDC" }),
          expect.objectContaining({ assetSymbol: "USDT" }),
        ],
      }),
      expect.objectContaining({
        maxSignatures: 200,
        maxTransactions: 100,
        concurrency: 4,
      }),
    );
    expect(fixture.rpcForRequest).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(fixture.rateLimits.consume).toHaveBeenCalledWith({
      clientDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      now: new Date("2026-08-16T00:00:00.000Z"),
    });
  });

  it("converts optional expectations into deterministic token evidence", async () => {
    const fixture = createFixture();
    const reference = "Gh5GixNvrU87vKWcLLLp6dcgBGRDtP4EJesFu6rjif4";
    const response = await fixture.server.inject({
      ...validRequest,
      payload: {
        walletAddress,
        rangeDays: 30,
        expectation: {
          assetSymbol: "USDC",
          amountTokens: "12.500001",
          recipient: walletAddress,
          reference,
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(fixture.analyze).toHaveBeenCalledWith(
      expect.objectContaining({
        expectation: {
          assetSymbol: "USDC",
          amountBaseUnits: "12500001",
          destinationTokenAccount:
            "HAUgWy5MnuMVkrk2FYsQrSrFt7J2joakh5zHGBQ5yPZ4",
          reference,
        },
      }),
      expect.any(Object),
    );
  });

  it("rejects invalid input before rate limiting or RPC access", async () => {
    const fixture = createFixture();
    const response = await fixture.server.inject({
      ...validRequest,
      payload: { walletAddress: "not-an-address", rangeDays: 7 },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: "invalid_public_analysis_request",
      requestId: expect.any(String),
      details: { field: "walletAddress" },
    });
    expect(fixture.rateLimits.consume).not.toHaveBeenCalled();
    expect(fixture.rpcForRequest).not.toHaveBeenCalled();
    expect(fixture.analyze).not.toHaveBeenCalled();
  });

  it("rejects extra keys and recipients without an asset", async () => {
    const fixture = createFixture();
    const extra = await fixture.server.inject({
      ...validRequest,
      payload: { walletAddress, rangeDays: 7, unsafe: true },
    });
    const recipientWithoutAsset = await fixture.server.inject({
      ...validRequest,
      payload: {
        walletAddress,
        rangeDays: 7,
        expectation: { recipient: walletAddress },
      },
    });

    expect(extra.statusCode).toBe(400);
    expect(recipientWithoutAsset.statusCode).toBe(400);
    expect(recipientWithoutAsset.json()).toMatchObject({
      details: { field: "recipient" },
    });
    expect(fixture.rateLimits.consume).not.toHaveBeenCalled();
    expect(fixture.analyze).not.toHaveBeenCalled();
  });

  it("rejects untrusted origins with a request ID", async () => {
    const fixture = createFixture();
    const response = await fixture.server.inject({
      ...validRequest,
      headers: { origin: "https://evil.example" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      code: "untrusted_origin",
      requestId: expect.any(String),
    });
    expect(fixture.rateLimits.consume).not.toHaveBeenCalled();
    expect(fixture.analyze).not.toHaveBeenCalled();
  });

  it("returns retry-after for a rejected rate-limit claim", async () => {
    const fixture = createFixture();
    fixture.rateLimits.consume.mockResolvedValueOnce({
      allowed: false,
      limit: 5,
      remaining: 0,
      retryAfterSeconds: 42,
    });
    const response = await fixture.server.inject(validRequest);

    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("42");
    expect(response.json()).toMatchObject({
      code: "public_analysis_rate_limited",
      requestId: expect.any(String),
    });
    expect(fixture.rpcForRequest).not.toHaveBeenCalled();
    expect(fixture.analyze).not.toHaveBeenCalled();
  });

  it("maps provider failures to a safe unavailable response", async () => {
    const fixture = createFixture();
    fixture.analyze.mockRejectedValueOnce(
      Object.assign(new Error("secret upstream provider detail"), {
        code: "analysis_unavailable",
      }),
    );
    const response = await fixture.server.inject(validRequest);

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      code: "public_analysis_unavailable",
      requestId: expect.any(String),
    });
    expect(response.body).not.toContain("secret upstream provider detail");
  });

  it("answers exact-origin preflight for POST with content-type only", async () => {
    const fixture = createFixture();
    const response = await fixture.server.inject({
      method: "OPTIONS",
      url: "/v1/public/wallet-analysis",
      headers: { origin },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe(origin);
    expect(response.headers["access-control-allow-methods"]).toBe("POST");
    expect(response.headers["access-control-allow-headers"]).toBe(
      "content-type",
    );
  });
});
