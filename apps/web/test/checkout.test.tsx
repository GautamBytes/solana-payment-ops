import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CheckoutClient } from "../app/pay/[token]/checkout-client";
import { AssetChoice } from "../components/asset-choice";
import { PaymentRequest } from "../components/payment-request";
import { stationIndex } from "../components/settlement-rail";
import {
  checkoutTokenFromPath,
  createPaymentAttempt,
  fetchCheckout,
  formatMinorUnits,
  type PublicCheckout,
  type PublicPaymentAttempt,
  type PublicPaymentStatus,
} from "../lib/api";
import { nextStatusPollDelay, statusAnnouncement } from "../lib/polling";
import { checkoutSecurityHeaders } from "../lib/security-headers";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("public checkout", () => {
  it("formats fiat exactly without Number conversion", () => {
    expect(formatMinorUnits("INR", "123456789012345678901")).toBe(
      "INR 12,34,56,78,90,12,34,56,789.01",
    );
    expect(formatMinorUnits("USD", "1")).toBe("USD 0.01");
  });

  it("accepts only the exact token-bearing checkout path", () => {
    const token = "A".repeat(43);
    expect(checkoutTokenFromPath(`/pay/${token}`)).toBe(token);
    expect(() => checkoutTokenFromPath(`/pay/${token}/status`)).toThrow(
      "checkout_not_found",
    );
    expect(() => checkoutTokenFromPath("/pay/not-a-token")).toThrow(
      "checkout_not_found",
    );
  });

  it("keeps provisional confirmation before finality on the settlement rail", () => {
    expect(stationIndex("awaiting_payment")).toBe(0);
    expect(stationIndex("confirmed")).toBe(1);
    expect(stationIndex("finalized")).toBe(2);
    expect(stationIndex("paid")).toBe(3);
    expect(stationIndex("confirmation_revoked")).toBe(0);
  });

  it("renders merchant text as text and requires an explicit asset choice", () => {
    const checkout = fixture();
    const markup = renderToStaticMarkup(
      createElement(CheckoutClient, {
        initialCheckout: {
          ...checkout,
          merchant: { displayName: '<img src=x onerror="alert(1)">' },
        },
      }),
    );
    expect(markup).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(markup).not.toContain("<img src=x");
    expect(markup).toContain("Choose USDC or USDT");
    expect(markup).toContain("disabled");
  });

  it("uses real buttons with pressed state for asset choice", () => {
    const markup = renderToStaticMarkup(
      createElement(AssetChoice, {
        assets: fixture().acceptedAssets,
        selected: "USDC",
        disabled: false,
        onSelect: () => undefined,
      }),
    );
    expect(markup).toContain('type="button"');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain("USDC");
    expect(markup).toContain("USDT");
  });

  it("exposes payment actions only while the attempt is awaiting payment", () => {
    const payable = renderPaymentRequest("awaiting_payment");
    expect(payable).toContain('href="solana:');
    expect(payable).toContain("Scan with a Solana Pay wallet");
    expect(payable).toContain("Copy payment link");

    const nonPayable: readonly PublicPaymentStatus[] = [
      "detected",
      "confirmed",
      "finalized",
      "paid",
      "confirmation_revoked",
      "exception",
    ];
    for (const status of nonPayable) {
      const markup = renderPaymentRequest(status);
      expect(markup, status).not.toContain('href="solana:');
      expect(markup, status).not.toContain("Scan with a Solana Pay wallet");
      expect(markup, status).not.toContain("Copy payment link");
      expect(markup, status).not.toContain("Copy recipient address");
    }
  });

  it("does not expose an expired request even before the status poll catches up", () => {
    const markup = renderToStaticMarkup(
      createElement(PaymentRequest, {
        attempt: attemptFixture("awaiting_payment"),
        now: Date.parse("2026-08-12T12:15:00.000Z"),
        onRefresh: () => undefined,
      }),
    );
    expect(markup).not.toContain('href="solana:');
    expect(markup).not.toContain("Scan with a Solana Pay wallet");
    expect(markup).toContain("Get a new quote");
  });

  it("fails closed on malformed server responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ schemaVersion: "0.1" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    await expect(
      fetchCheckout("A".repeat(43), "https://api.example.com"),
    ).rejects.toThrow("checkout_unavailable");
  });

  it("sends the caller's stable idempotency key when creating a quote", async () => {
    vi.stubEnv("NEXT_PUBLIC_PAYOPS_API_ORIGIN", "https://api.example.com");
    const request = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("idempotency-key")).toBe(
          "checkout-attempt-0000000000000001",
        );
        return Response.json(attemptFixture("awaiting_payment"), {
          status: 201,
        });
      },
    );
    vi.stubGlobal("fetch", request);

    await Reflect.apply(createPaymentAttempt, null, [
      "A".repeat(43),
      "USDC",
      "checkout-attempt-0000000000000001",
    ]);

    expect(request).toHaveBeenCalledOnce();
  });

  it("rejects a Solana Pay URL whose signed request fields disagree", async () => {
    const checkout = fixture();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          ...checkout,
          currentAttempt: {
            publicAttemptId: "123e4567-e89b-42d3-a456-426614174000",
            assetSymbol: "USDC",
            mint: checkout.acceptedAssets[0]!.mint,
            amountTokens: "1",
            amountBaseUnits: "1000000",
            paymentUrl:
              "solana:11111111111111111111111111111111?amount=2&spl-token=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&reference=11111111111111111111111111111112&label=Acme&message=Invoice+INV-1042",
            reference: "11111111111111111111111111111112",
            quoteExpiresAt: "2026-08-12T12:15:00.000Z",
            status: "awaiting_payment",
            statusUpdatedAt: "2026-08-12T12:00:00.000Z",
          },
        }),
      ),
    );
    await expect(
      fetchCheckout("A".repeat(43), "https://api.example.com"),
    ).rejects.toThrow("checkout_unavailable");
  });

  it("backs status polling off by age with bounded jitter and failures", () => {
    expect(
      nextStatusPollDelay({ elapsedMs: 0, consecutiveFailures: 0, random: 0 }),
    ).toBe(2_000);
    expect(
      nextStatusPollDelay({
        elapsedMs: 60_000,
        consecutiveFailures: 0,
        random: 0,
      }),
    ).toBe(5_000);
    expect(
      nextStatusPollDelay({
        elapsedMs: 600_000,
        consecutiveFailures: 0,
        random: 0,
      }),
    ).toBe(15_000);
    expect(
      nextStatusPollDelay({
        elapsedMs: 0,
        consecutiveFailures: 1,
        random: 0.5,
      }),
    ).toBe(4_200);
    expect(
      nextStatusPollDelay({
        elapsedMs: 0,
        consecutiveFailures: 9,
        random: 0.999,
      }),
    ).toBeLessThanOrEqual(16_500);
  });

  it("announces meaningful settlement transitions", () => {
    expect(statusAnnouncement("confirmed")).toContain("finality");
    expect(statusAnnouncement("paid")).toBe("Invoice paid.");
    expect(statusAnnouncement("awaiting_payment")).toBe("");
  });

  it("builds strict token-safe checkout response headers", () => {
    const headers = checkoutSecurityHeaders({
      nonce: "YWJjZA==",
      apiOrigin: "https://api.payops.example",
      development: false,
    });
    expect(headers["Cache-Control"]).toBe("private, no-store");
    expect(headers["Referrer-Policy"]).toBe("no-referrer");
    expect(headers["Content-Security-Policy"]).toContain(
      "frame-ancestors 'none'",
    );
    expect(headers["Content-Security-Policy"]).toContain(
      "connect-src 'self' https://api.payops.example",
    );
    expect(headers["Content-Security-Policy"]).not.toContain("unsafe-inline");
  });
});

function fixture(): PublicCheckout {
  return {
    schemaVersion: "0.1",
    merchant: { displayName: "Acme India" },
    invoice: {
      publicReference: "INV-1042",
      currency: "INR",
      totalMinorUnits: "805000",
      dueAt: "2026-08-20T00:00:00.000Z",
      status: "issued",
    },
    acceptedAssets: [
      {
        symbol: "USDC",
        mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        decimals: 6,
      },
      {
        symbol: "USDT",
        mint: "Es9vMFrzaCERmJfrF4H2FYDk61ZQ3UvWkExMfyxssZA1",
        decimals: 6,
      },
    ],
    currentAttempt: null,
  };
}

function attemptFixture(status: PublicPaymentStatus): PublicPaymentAttempt {
  return {
    publicAttemptId: "123e4567-e89b-42d3-a456-426614174000",
    assetSymbol: "USDC",
    mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    amountTokens: "1",
    amountBaseUnits: "1000000",
    paymentUrl:
      "solana:11111111111111111111111111111111?amount=1&spl-token=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&reference=11111111111111111111111111111112&label=Acme&message=Invoice+INV-1042",
    reference: "11111111111111111111111111111112",
    quoteExpiresAt: "2026-08-12T12:15:00.000Z",
    status,
    statusUpdatedAt: "2026-08-12T12:00:00.000Z",
  };
}

function renderPaymentRequest(status: PublicPaymentStatus): string {
  return renderToStaticMarkup(
    createElement(PaymentRequest, {
      attempt: attemptFixture(status),
      now: Date.parse("2026-08-12T12:10:00.000Z"),
      onRefresh: () => undefined,
    }),
  );
}
