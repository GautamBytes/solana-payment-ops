import { afterEach, describe, expect, it, vi } from "vitest";

import { analyzeWallet } from "../lib/public-wallet-analysis.js";

const walletAddress = "LcNR2RPX9mMG1a23dfG6yQNvLUctx4sniKXKH9TV3ym";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("public wallet analysis transport", () => {
  it("uses the same-origin route when no external API origin is configured", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          schemaVersion: "0.1",
          walletAddress,
          fromTime: "2026-08-09T00:00:00.000Z",
          throughTime: "2026-08-16T00:00:00.000Z",
          coverage: "complete",
          transfers: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetch);

    await expect(
      analyzeWallet({ walletAddress, rangeDays: 7 }),
    ).resolves.toMatchObject({ walletAddress, coverage: "complete" });
    expect(fetch).toHaveBeenCalledWith(
      "/v1/public-wallet-analysis",
      expect.objectContaining({ method: "POST", credentials: "omit" }),
    );
  });
});
