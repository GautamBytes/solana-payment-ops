import { describe, expect, it, vi } from "vitest";

import { createEmbeddedPublicWalletAnalysisHandler } from "../lib/server/embedded-public-wallet-analysis.js";

const origin = "https://pay.example";
const walletAddress = "LcNR2RPX9mMG1a23dfG6yQNvLUctx4sniKXKH9TV3ym";
const validBody = { walletAddress, rangeDays: 7 };

function request(
  body: unknown = validBody,
  headers: Record<string, string> = {},
): Request {
  return new Request(`${origin}/v1/public-wallet-analysis`, {
    method: "POST",
    headers: {
      origin,
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function fixture(enabled = true) {
  const analyze = vi.fn(async () => ({
    schemaVersion: "0.1" as const,
    walletAddress,
    fromTime: "2026-08-09T00:00:00.000Z",
    throughTime: "2026-08-16T00:00:00.000Z",
    coverage: "complete" as const,
    transfers: [],
  }));
  const rpc = {
    getSignaturesForAddress: vi.fn(async () => []),
    getTransaction: vi.fn(async () => null),
    getSignatureStatuses: vi.fn(async () => []),
    getSlot: vi.fn(async () => 0n),
  };
  const rpcForRequest = vi.fn(() => rpc);
  const handler = createEmbeddedPublicWalletAnalysisHandler({
    isEnabled: () => enabled,
    analyze,
    rpcForRequest,
    now: () => new Date("2026-08-16T00:00:00.000Z"),
    requestId: () => "00000000-0000-4000-8000-000000000123",
  });
  return { handler, analyze, rpcForRequest };
}

describe("embedded public wallet analysis", () => {
  it("is unavailable unless explicitly enabled", async () => {
    const { handler, analyze } = fixture(false);
    const response = await handler(request());

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(analyze).not.toHaveBeenCalled();
  });

  it("requires a same-origin JSON browser request", async () => {
    const { handler, analyze } = fixture();
    const wrongOrigin = await handler(
      request(validBody, { origin: "https://evil.example" }),
    );
    const wrongType = await handler(
      request(validBody, { "content-type": "text/plain" }),
    );

    expect(wrongOrigin.status).toBe(403);
    expect(wrongType.status).toBe(415);
    expect(analyze).not.toHaveBeenCalled();
  });

  it("rejects oversized and invalid bodies before RPC work", async () => {
    const { handler, analyze, rpcForRequest } = fixture();
    const oversized = await handler(
      request({ walletAddress: "1".repeat(2_100), rangeDays: 7 }),
    );
    const invalid = await handler(
      request({ walletAddress: "not-an-address", rangeDays: 7 }),
    );

    expect(oversized.status).toBe(413);
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({
      code: "invalid_public_analysis_request",
      details: { field: "walletAddress" },
      requestId: "00000000-0000-4000-8000-000000000123",
    });
    expect(rpcForRequest).not.toHaveBeenCalled();
    expect(analyze).not.toHaveBeenCalled();
  });

  it("runs the existing analyzer with preview-safe resource bounds", async () => {
    const { handler, analyze, rpcForRequest } = fixture();
    const response = await handler(request());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(rpcForRequest).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(analyze).toHaveBeenCalledWith(
      expect.objectContaining({ walletAddress }),
      expect.objectContaining({
        maxSignatures: 40,
        maxTransactions: 20,
        concurrency: 2,
      }),
    );
    expect(await response.json()).toMatchObject({
      schemaVersion: "0.1",
      walletAddress,
    });
  });

  it("maps upstream failures to a stable response without leaking details", async () => {
    const { handler, analyze } = fixture();
    analyze.mockRejectedValueOnce(
      new Error("secret Solana provider credential and response"),
    );
    const response = await handler(request());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      code: "public_analysis_unavailable",
      message: "Public analysis is temporarily unavailable",
      requestId: "00000000-0000-4000-8000-000000000123",
    });
  });
});
