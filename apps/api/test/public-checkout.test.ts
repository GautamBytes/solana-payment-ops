import { randomUUID } from "node:crypto";
import type {
  CheckoutRecord,
  PublicCheckoutView,
  PublicPaymentAttempt,
} from "@payops/platform";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { installRequestContext } from "../src/protocol/request-context.js";
import { registerCheckoutRoutes } from "../src/routes/public-checkout.js";
import { CheckoutTokenKeyring } from "../src/security/public-token.js";

const organizationId = "00000000-0000-4000-8000-000000000001";
const checkoutId = "00000000-0000-4000-8000-000000000123";
const invoiceId = "00000000-0000-4000-8000-000000000124";

describe("public checkout routes", () => {
  it("returns a minimized no-store checkout and indistinguishable 404s", async () => {
    const fixture = createFixture();
    const server = fixture.server;
    try {
      const found = await server.inject({
        method: "GET",
        url: `/pay/${fixture.token}`,
        headers: { origin: "https://pay.example" },
      });
      expect(found.statusCode).toBe(200);
      expect(found.headers["cache-control"]).toBe("private, no-store");
      expect(found.headers["referrer-policy"]).toBe("no-referrer");
      expect(found.headers["x-robots-tag"]).toContain("noindex");
      expect(found.headers["access-control-allow-origin"]).toBe(
        "https://pay.example",
      );
      expect(found.json()).toEqual(fixture.view);
      expect(found.body).not.toContain(organizationId);
      expect(found.body).not.toContain(invoiceId);
      expect(found.body).not.toContain(fixture.token);

      const malformed = await server.inject({
        method: "GET",
        url: "/pay/not-a-token",
      });
      const unknown = await server.inject({
        method: "GET",
        url: `/pay/${"A".repeat(43)}`,
      });
      expect(malformed.statusCode).toBe(404);
      expect(unknown.statusCode).toBe(404);
      expect(malformed.json()).toMatchObject({ code: "checkout_not_found" });
      expect(unknown.json()).toMatchObject({ code: "checkout_not_found" });
    } finally {
      await server.close();
    }
  });

  it("requires the exact checkout origin to create a quote and supports ETag polling", async () => {
    const fixture = createFixture();
    try {
      const rejected = await fixture.server.inject({
        method: "POST",
        url: `/pay/${fixture.token}/quotes`,
        headers: { origin: "https://evil.example" },
        payload: { assetSymbol: "USDC" },
      });
      expect(rejected.statusCode).toBe(403);
      expect(fixture.createAttempt).not.toHaveBeenCalled();

      const missingIdempotencyKey = await fixture.server.inject({
        method: "POST",
        url: `/pay/${fixture.token}/quotes`,
        headers: { origin: "https://pay.example" },
        payload: { assetSymbol: "USDC" },
      });
      expect(missingIdempotencyKey.statusCode).toBe(400);
      expect(missingIdempotencyKey.json()).toMatchObject({
        code: "invalid_idempotency_key",
      });
      expect(fixture.createAttempt).not.toHaveBeenCalled();

      const created = await fixture.server.inject({
        method: "POST",
        url: `/pay/${fixture.token}/quotes`,
        headers: {
          origin: "https://pay.example",
          "idempotency-key": "checkout-attempt-0000000000000001",
        },
        payload: { assetSymbol: "USDC" },
      });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toEqual(fixture.attempt);
      expect(fixture.createAttempt).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId,
          checkoutId,
          assetSymbol: "USDC",
          idempotencyKey: "checkout-attempt-0000000000000001",
        }),
      );

      const status = await fixture.server.inject({
        method: "GET",
        url: `/pay/${fixture.token}/status`,
      });
      expect(status.statusCode).toBe(200);
      const etag = status.headers.etag;
      expect(etag).toMatch(/^"[A-Za-z0-9_-]{43}"$/);
      const unchanged = await fixture.server.inject({
        method: "GET",
        url: `/pay/${fixture.token}/status`,
        headers: { "if-none-match": etag! },
      });
      expect(unchanged.statusCode).toBe(304);
      expect(unchanged.body).toBe("");
    } finally {
      await fixture.server.close();
    }
  });

  it("regenerates the same merchant link without persisting raw token bytes", async () => {
    const fixture = createFixture();
    try {
      const first = await fixture.server.inject({
        method: "POST",
        url: `/v1/invoices/${invoiceId}/checkout-links`,
        payload: {},
      });
      const second = await fixture.server.inject({
        method: "POST",
        url: `/v1/invoices/${invoiceId}/checkout-links`,
        payload: {},
      });
      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(201);
      expect(first.body).toBe(second.body);
      expect(first.json().checkoutUrl).toBe(
        `https://pay.example/pay/${fixture.token}`,
      );
    } finally {
      await fixture.server.close();
    }
  });

  it("reports unavailable instead of not-found when a token rotation key is missing", async () => {
    const fixture = createFixture({ derivationKeyId: "retired-key" });
    try {
      const response = await fixture.server.inject({
        method: "POST",
        url: `/v1/invoices/${invoiceId}/checkout-links`,
        payload: {},
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ code: "checkout_unavailable" });
    } finally {
      await fixture.server.close();
    }
  });

  it("lets an authorized merchant create an attempt for an active invoice checkout", async () => {
    const fixture = createFixture();
    try {
      const response = await fixture.server.inject({
        method: "POST",
        url: `/v1/invoices/${invoiceId}/payment-attempts`,
        headers: { "idempotency-key": "merchant-attempt-0000000000000001" },
        payload: { assetSymbol: "USDT" },
      });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual(fixture.attempt);
      expect(fixture.createAttempt).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId,
          checkoutId,
          assetSymbol: "USDT",
          idempotencyKey: "merchant-attempt-0000000000000001",
        }),
      );
    } finally {
      await fixture.server.close();
    }
  });
});

function createFixture(options: { readonly derivationKeyId?: string } = {}) {
  const keyring = new CheckoutTokenKeyring([
    {
      id: "key-v1",
      secret: Buffer.alloc(32, 1).toString("base64url"),
    },
  ]);
  const publicNonce = Buffer.alloc(32, 7);
  const token = keyring.derive(checkoutId, publicNonce, "key-v1").token;
  const checkout: CheckoutRecord = {
    checkoutId,
    organizationId,
    invoiceId,
    publicNonce,
    derivationKeyId: options.derivationKeyId ?? "key-v1",
    state: "active",
    version: 1,
    createdAt: "2026-08-12T12:00:00.000Z",
    revokedAt: null,
  };
  const attempt: PublicPaymentAttempt = {
    publicAttemptId: randomUUID(),
    assetSymbol: "USDC",
    mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    amountTokens: "1",
    amountBaseUnits: "1000000",
    paymentUrl: "solana:11111111111111111111111111111111?amount=1",
    reference: "11111111111111111111111111111112",
    quoteExpiresAt: "2026-08-12T12:15:00.000Z",
    status: "awaiting_payment",
    statusUpdatedAt: "2026-08-12T12:00:00.000Z",
  };
  const view: PublicCheckoutView = {
    schemaVersion: "0.1",
    merchant: { displayName: "Acme India" },
    invoice: {
      publicReference: "INV-100",
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
    currentAttempt: null,
  };
  const createAttempt = vi.fn(async () => attempt);
  const server = Fastify({ logger: false });
  installRequestContext(server);
  registerCheckoutRoutes(server, {
    auth: {
      resolve: async () => ({
        kind: "api_key",
        actorId: "merchant-key",
        organizationId,
        permissions: {
          organizationRead: true,
          memberAdmin: false,
          apiKeyAdmin: false,
          walletRead: true,
          walletAdmin: false,
          customerRead: true,
          customerWrite: true,
          invoiceRead: true,
          invoiceWrite: true,
          invoiceIssue: true,
          paymentReview: true,
          accountingRead: true,
        },
      }),
      close: async () => undefined,
    },
    checkouts: {
      getActiveForInvoice: async () => checkout,
      create: async () => checkout,
      resolve: async (digest) =>
        digest === keyring.digestToken(token) ? checkout : null,
      publicView: async () => view,
    },
    tokens: keyring,
    paymentAttempts: { create: createAttempt },
    rateLimits: {
      consume: async () => ({
        allowed: true,
        limit: 600,
        remaining: 599,
        retryAfterSeconds: 0,
      }),
    },
    checkoutOrigin: "https://pay.example",
  });
  return { server, token, attempt, view, createAttempt };
}
