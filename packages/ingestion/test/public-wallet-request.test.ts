import { describe, expect, it } from "vitest";

import {
  preparePublicWalletAnalysisRequest,
  PublicWalletRequestError,
} from "../src/public-analysis/request.js";

const walletAddress = "LcNR2RPX9mMG1a23dfG6yQNvLUctx4sniKXKH9TV3ym";
const reference = "Gh5GixNvrU87vKWcLLLp6dcgBGRDtP4EJesFu6rjif4";
const now = new Date("2026-08-16T00:00:00.000Z");

describe("public wallet request preparation", () => {
  it("prepares a bounded request with canonical token accounts", async () => {
    const prepared = await preparePublicWalletAnalysisRequest(
      { walletAddress, rangeDays: 7 },
      now,
    );

    expect(prepared.request).toEqual({ walletAddress, rangeDays: 7 });
    expect(prepared.input).toMatchObject({
      walletAddress,
      fromTime: new Date("2026-08-09T00:00:00.000Z"),
      throughTime: now,
      watchedTokenAccounts: [
        {
          assetSymbol: "USDC",
          address: "HAUgWy5MnuMVkrk2FYsQrSrFt7J2joakh5zHGBQ5yPZ4",
        },
        { assetSymbol: "USDT", address: expect.any(String) },
      ],
    });
  });

  it("converts exact optional expectations into analyzer input", async () => {
    const prepared = await preparePublicWalletAnalysisRequest(
      {
        walletAddress,
        rangeDays: 30,
        expectation: {
          assetSymbol: "USDC",
          amountTokens: "12.500001",
          recipient: walletAddress,
          reference,
        },
      },
      now,
    );

    expect(prepared.input.expectation).toEqual({
      assetSymbol: "USDC",
      amountBaseUnits: "12500001",
      destinationTokenAccount: "HAUgWy5MnuMVkrk2FYsQrSrFt7J2joakh5zHGBQ5yPZ4",
      reference,
    });
  });

  it.each([
    [{ walletAddress: "not-an-address", rangeDays: 7 }, "walletAddress"],
    [{ walletAddress, rangeDays: 14 }, "rangeDays"],
    [{ walletAddress, rangeDays: 7, unsafe: true }, "walletAddress"],
    [
      {
        walletAddress,
        rangeDays: 7,
        expectation: { recipient: walletAddress },
      },
      "recipient",
    ],
    [
      {
        walletAddress,
        rangeDays: 7,
        expectation: { amountTokens: "1.0000001" },
      },
      "amountTokens",
    ],
  ])("rejects invalid input before upstream work", async (value, field) => {
    await expect(
      preparePublicWalletAnalysisRequest(value, now),
    ).rejects.toEqual(expect.objectContaining({ field }));
  });

  it("uses a stable safe request error", () => {
    expect(new PublicWalletRequestError("reference")).toMatchObject({
      name: "PublicWalletRequestError",
      message: "Public wallet analysis request is invalid",
      field: "reference",
    });
  });
});
