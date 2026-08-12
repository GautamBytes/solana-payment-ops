// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CheckoutClient } from "../app/pay/[token]/checkout-client";
import type {
  PublicCheckout,
  PublicPaymentAttempt,
  PublicStatus,
} from "../lib/api";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("checkout quote replacement", () => {
  it("keeps the expired request visible until its replacement succeeds", async () => {
    const token = "A".repeat(43);
    window.history.pushState({}, "", `/pay/${token}`);
    vi.stubEnv("NEXT_PUBLIC_PAYOPS_API_ORIGIN", "https://api.example.com");
    const attempt = attemptFixture();
    const status: PublicStatus = {
      invoiceStatus: "issued",
      currentAttempt: attempt,
    };
    const request = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) =>
        init?.method === "POST"
          ? Response.json({ code: "quote_unavailable" }, { status: 503 })
          : Response.json(status, { status: 200, headers: { etag: '"v1"' } }),
    );
    vi.stubGlobal("fetch", request);

    const view = render(
      <CheckoutClient initialCheckout={checkoutFixture(attempt)} />,
    );
    expect(screen.queryByText("Exact payment request")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Get a new quote" }));

    expect(screen.queryByText("Exact payment request")).not.toBeNull();
    await waitFor(() =>
      expect(
        request.mock.calls.some(([, init]) => init?.method === "POST"),
      ).toBe(true),
    );
    expect(screen.queryByText("Exact payment request")).not.toBeNull();
    view.unmount();
  });
});

function checkoutFixture(attempt: PublicPaymentAttempt): PublicCheckout {
  return {
    schemaVersion: "0.1",
    merchant: { displayName: "Acme India" },
    invoice: {
      publicReference: "INV-1042",
      currency: "USD",
      totalMinorUnits: "100",
      dueAt: "2026-08-20T00:00:00.000Z",
      status: "issued",
    },
    acceptedAssets: [
      {
        symbol: "USDC",
        mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        decimals: 6,
      },
    ],
    currentAttempt: attempt,
  };
}

function attemptFixture(): PublicPaymentAttempt {
  return {
    publicAttemptId: "123e4567-e89b-42d3-a456-426614174000",
    assetSymbol: "USDC",
    mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    amountTokens: "1",
    amountBaseUnits: "1000000",
    paymentUrl:
      "solana:11111111111111111111111111111111?amount=1&spl-token=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&reference=11111111111111111111111111111112&label=Acme&message=Invoice+INV-1042",
    reference: "11111111111111111111111111111112",
    quoteExpiresAt: "2020-08-12T12:15:00.000Z",
    status: "expired",
    statusUpdatedAt: "2020-08-12T12:15:00.000Z",
  };
}
