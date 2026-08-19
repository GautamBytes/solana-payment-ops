import { describe, expect, it, vi } from "vitest";

import { createEmbeddedPublicWalletAnalysisHandler } from "../lib/server/embedded-public-wallet-analysis.js";
import type { PublicAnalysisCompletion } from "../lib/server/public-analysis-observability.js";

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
  const events: PublicAnalysisCompletion[] = [];
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
    logCompleted: (event) => events.push(event),
  });
  return { handler, analyze, events, rpcForRequest };
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
    const { handler, analyze, events } = fixture();
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
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "public_analysis_request_completed",
        requestId: "00000000-0000-4000-8000-000000000123",
        route: "/v1/public-wallet-analysis",
        statusClass: "5xx",
        code: "public_analysis_unavailable",
      }),
    );
    expect(JSON.stringify(events)).not.toContain("secret");
    expect(JSON.stringify(events)).not.toContain(walletAddress);
  });

  it("records a safe upstream failure class without logging its cause", async () => {
    const { handler, analyze, events } = fixture();
    analyze.mockRejectedValueOnce(
      Object.assign(new Error("provider response included a secret token"), {
        code: "analysis_unavailable",
        cause: Object.assign(new Error("private endpoint failed"), {
          code: "rpc_error",
        }),
      }),
    );

    const response = await handler(request());

    expect(response.status).toBe(503);
    expect(events).toContainEqual(
      expect.objectContaining({ code: "public_analysis_rpc_error" }),
    );
    expect(JSON.stringify(events)).not.toContain("secret token");
    expect(JSON.stringify(events)).not.toContain("private endpoint");
  });
});
