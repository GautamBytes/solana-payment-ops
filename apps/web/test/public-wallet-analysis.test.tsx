// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TryWorkspaceView } from "../components/try-workspace";
import {
  analyzeWallet,
  parsePublicWalletAnalysis,
  PublicWalletClientError,
} from "../lib/public-wallet-analysis";
import { sampleWorkspace } from "../lib/try/sample-workspace";

vi.mock("../lib/public-wallet-analysis", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/public-wallet-analysis")>()),
  analyzeWallet: vi.fn(),
}));

const walletAddress = "LcNR2RPX9mMG1a23dfG6yQNvLUctx4sniKXKH9TV3ym";
const requestId = "00000000-0000-4000-8000-000000000123";

function validResponse() {
  return {
    schemaVersion: "0.1",
    walletAddress,
    fromTime: "2026-08-09T00:00:00.000Z",
    throughTime: "2026-08-16T00:00:00.000Z",
    coverage: "complete",
    transfers: [
      {
        signature: "2".repeat(88),
        slot: "345678901",
        blockTime: "2026-08-15T10:00:00.000Z",
        assetSymbol: "USDC",
        mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        amountBaseUnits: "12500000",
        amountTokens: "12.5",
        sourceTokenAccount: "8rUz82MkFsfqjpVjjgWEM66Brr1sm1R7VKZ991fF41e",
        destinationTokenAccount: "Cmn8RVNLZAtyq51B31RXDrrS24DYphEftzDCX4FzPLM",
        references: ["Gh5GixNvrU87vKWcLLLp6dcgBGRDtP4EJesFu6rjif4"],
        expectationStatus: "matched",
        expectationChecks: [
          { field: "asset", passed: true },
          { field: "amount", passed: true },
          { field: "recipient", passed: true },
          { field: "reference", passed: true },
        ],
      },
    ],
  };
}

beforeEach(() => {
  vi.mocked(analyzeWallet).mockReset();
});

describe("public wallet analysis client", () => {
  it("parses a complete bounded response", () => {
    expect(parsePublicWalletAnalysis(validResponse())).toEqual(validResponse());
  });

  it("rejects oversized and unknown response values", () => {
    expect(() =>
      parsePublicWalletAnalysis({
        ...validResponse(),
        transfers: Array.from(
          { length: 101 },
          () => validResponse().transfers[0],
        ),
      }),
    ).toThrow(expect.objectContaining({ code: "invalid_response" }));
    expect(() =>
      parsePublicWalletAnalysis({
        ...validResponse(),
        transfers: [
          { ...validResponse().transfers[0], expectationStatus: "approved" },
        ],
      }),
    ).toThrow(expect.objectContaining({ code: "invalid_response" }));
  });

  it("maps rate limits and unavailable bodies without exposing provider text", async () => {
    const limited = await PublicWalletClientError.fromResponse(
      new Response(
        JSON.stringify({
          code: "public_analysis_rate_limited",
          message: "attacker-controlled text",
          requestId,
        }),
        { status: 429, headers: { "retry-after": "42" } },
      ),
    );
    const unavailable = await PublicWalletClientError.fromResponse(
      new Response(
        JSON.stringify({
          code: "public_analysis_unavailable",
          message: "secret upstream provider detail",
          requestId,
        }),
        { status: 503 },
      ),
    );

    expect(limited).toMatchObject({
      code: "rate_limited",
      retryAfterSeconds: 42,
      requestId,
    });
    expect(unavailable).toMatchObject({ code: "unavailable", requestId });
    expect(`${limited.message} ${unavailable.message}`).not.toMatch(
      /attacker|provider detail/,
    );
  });
});

describe("public wallet analysis mode", () => {
  it("does not render a dead public-wallet action when disabled", () => {
    const markup = renderToStaticMarkup(
      createElement(TryWorkspaceView, {
        workspace: sampleWorkspace,
        publicWalletEnabled: false,
      }),
    );
    expect(markup).not.toContain("Use a public wallet");
  });

  it("renders the safe public-wallet form when enabled", () => {
    const markup = renderToStaticMarkup(
      createElement(TryWorkspaceView, {
        workspace: sampleWorkspace,
        publicWalletEnabled: true,
      }),
    );
    expect(markup).toContain("Use a public wallet");
    expect(markup).toContain("Never enter a seed phrase or private key");
    expect(markup).toContain('name="walletAddress"');
    expect(markup).toContain('name="rangeDays"');
    expect(markup).toContain(
      "Currently supports canonical USDC and USDT transfers only.",
    );
    expect(markup).toContain('role="status"');
    expect(markup).not.toMatch(/connect wallet/i);
  });

  it("focuses field errors without clearing entered values", () => {
    render(
      <TryWorkspaceView
        workspace={sampleWorkspace}
        publicWalletEnabled={true}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Use a public wallet" }));

    const wallet = screen.getByLabelText("Public wallet address");
    fireEvent.change(wallet, { target: { value: "not-an-address" } });
    fireEvent.click(screen.getByRole("button", { name: "Analyze wallet" }));
    expect(
      screen.getByText("Enter a valid public Solana address."),
    ).toBeTruthy();
    expect(document.activeElement).toBe(wallet);
    expect(wallet).toHaveProperty("value", "not-an-address");

    fireEvent.change(wallet, { target: { value: walletAddress } });
    const amount = screen.getByLabelText("Expected amount");
    fireEvent.change(amount, { target: { value: "12.1234567" } });
    fireEvent.click(screen.getByRole("button", { name: "Analyze wallet" }));
    expect(screen.getByText("Use up to six decimal places.")).toBeTruthy();
    expect(document.activeElement).toBe(amount);
    expect(wallet).toHaveProperty("value", walletAddress);
    expect(amount).toHaveProperty("value", "12.1234567");
    expect(analyzeWallet).not.toHaveBeenCalled();
  });
});
