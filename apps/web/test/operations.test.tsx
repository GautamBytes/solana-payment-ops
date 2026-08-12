import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OperationsDashboard } from "../components/operations-dashboard";
import {
  createAccountingExport,
  createEvidencePack,
  listPaymentExceptions,
  type PaymentException,
} from "../lib/operations-api";
import { checkoutSecurityHeaders } from "../lib/security-headers";
import { payopsCookieHeader } from "../lib/auth-cookie";

const REQUEST_ID = "123e4567-e89b-42d3-a456-426614174000";
const INVOICE_ID = "123e4567-e89b-42d3-a456-426614174001";
const EXCEPTION_ID = "123e4567-e89b-42d3-a456-426614174002";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("merchant operations", () => {
  it("forwards local and production secure PayOps cookies only", () => {
    expect(
      payopsCookieHeader([
        { name: "payops.session_token", value: "local" },
        { name: "__Secure-payops.session_token", value: "production" },
        { name: "payops.session_data", value: "local-cache" },
        { name: "__Secure-payops.account_data", value: "account-cache" },
        { name: "payops.attacker_controlled", value: "attacker" },
        { name: "__Secure-other.session_token", value: "secret" },
      ]),
    ).toBe(
      "payops.session_token=local; __Secure-payops.session_token=production",
    );
  });

  it("fetches a bounded exception page while forwarding only the session cookie", async () => {
    vi.stubEnv("PAYOPS_API_ORIGIN", "https://api.example.com");
    vi.stubEnv("PAYOPS_WEB_ORIGIN", "https://app.example.com");
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      Response.json(
        { data: [exceptionFixture()], nextCursor: null },
        {
          headers: { "content-type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetch);

    const page = await listPaymentExceptions("payops.session_token=safe", {
      state: "open",
      limit: 50,
    });

    expect(page.data).toHaveLength(1);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      "https://api.example.com/v1/exceptions?limit=50&state=open",
    );
    expect(new Headers(init?.headers).get("cookie")).toBe(
      "payops.session_token=safe",
    );
    expect(init?.redirect).toBe("error");
  });

  it("forwards the trusted origin and reuses each browser operation key", async () => {
    vi.stubEnv("PAYOPS_API_ORIGIN", "https://api.example.com");
    vi.stubEnv("PAYOPS_WEB_ORIGIN", "https://app.example.com");
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({ id: EXCEPTION_ID, invoiceId: INVOICE_ID }),
      )
      .mockResolvedValueOnce(
        Response.json({ id: EXCEPTION_ID, format: "quickbooks_csv" }),
      );
    vi.stubGlobal("fetch", fetch);

    await createEvidencePack("cookie", INVOICE_ID, REQUEST_ID);
    await createAccountingExport("cookie", {
      format: "quickbooks_csv",
      fromTime: "2026-08-01T00:00:00.000Z",
      throughTime: "2026-08-12T00:00:00.000Z",
      idempotencyKey: EXCEPTION_ID,
    });

    const first = new Headers(fetch.mock.calls[0]?.[1]?.headers).get(
      "idempotency-key",
    );
    const second = new Headers(fetch.mock.calls[1]?.[1]?.headers).get(
      "idempotency-key",
    );
    expect(first).toBe(REQUEST_ID);
    expect(second).toBe(EXCEPTION_ID);
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("origin")).toBe(
      "https://app.example.com",
    );
    expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).get("origin")).toBe(
      "https://app.example.com",
    );
  });

  it("renders a real exception work queue and audit-oriented actions", () => {
    const markup = renderToStaticMarkup(
      createElement(OperationsDashboard, {
        exceptions: [exceptionFixture()],
        now: new Date("2026-08-12T12:00:00.000Z"),
      }),
    );

    expect(markup).toContain("Payment operations");
    expect(markup).toContain("needs review");
    expect(markup).toContain("Wrong amount");
    expect(markup).toContain("125.500000 USDT");
    expect(markup).toContain("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB");
    expect(markup).toContain("Token decimals");
    expect(markup).toContain(">6</dd>");
    expect(markup).toContain("Assign case");
    expect(markup).toContain("Generate signed evidence");
    expect(markup).toContain("QuickBooks-ready CSV");
    expect(markup.match(/name="idempotencyKey"/gu)).toHaveLength(4);
  });

  it("escapes untrusted exception text", () => {
    const markup = renderToStaticMarkup(
      createElement(OperationsDashboard, {
        exceptions: [
          { ...exceptionFixture(), ruleCode: '<img src=x onerror="alert(1)">' },
        ],
        now: new Date("2026-08-12T12:00:00.000Z"),
      }),
    );
    expect(markup).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(markup).not.toContain("<img src=x");
  });

  it("allows only same-origin dashboard form submissions", () => {
    const headers = checkoutSecurityHeaders({
      nonce: "YWJjZA==",
      apiOrigin: "https://api.example.com",
      development: false,
      allowSameOriginForms: true,
    });
    expect(headers["Content-Security-Policy"]).toContain("form-action 'self'");
    expect(headers["Content-Security-Policy"]).toContain(
      "frame-ancestors 'none'",
    );
  });
});

function exceptionFixture(): PaymentException {
  return {
    id: EXCEPTION_ID,
    invoiceId: INVOICE_ID,
    attemptId: "123e4567-e89b-42d3-a456-426614174003",
    eventId: "event-001",
    signature: "4Nd1mY",
    amountBaseUnits: "125500000",
    assetSymbol: "USDT",
    mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    decimals: 6,
    ruleCode: "wrong_amount",
    ruleVersion: "1.0.0",
    reviewState: "open",
    assignedTo: null,
    resolutionCode: null,
    resolutionNote: null,
    resolvedBy: null,
    resolvedAt: null,
    version: 1,
    createdAt: "2026-08-12T10:00:00.000Z",
  };
}
