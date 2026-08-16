import { describe, expect, it } from "vitest";
import type { ApiConfig } from "../src/config.js";
import { buildApiServer } from "../src/server.js";

describe("OpenAPI runtime inventory", () => {
  it("keeps every documented merchant route registered", async () => {
    const server = buildApiServer(config(), {
      emailDelivery: { send: async () => undefined },
    });
    try {
      for (const [method, url] of [
        ["GET", "/health/live"],
        ["GET", "/health/ready"],
        ["POST", "/v1/auth/bootstrap/accept"],
        ["GET", "/v1/organization"],
        ["GET", "/v1/customers"],
        ["POST", "/v1/customers"],
        ["GET", "/v1/customers/:customerId"],
        ["GET", "/v1/invoices"],
        ["POST", "/v1/invoices"],
        ["GET", "/v1/invoices/:invoiceId"],
        ["POST", "/v1/invoices/:invoiceId/issue"],
        ["POST", "/v1/invoices/:invoiceId/cancel"],
        ["POST", "/v1/invoices/:invoiceId/checkout-links"],
        ["POST", "/v1/invoices/:invoiceId/payment-attempts"],
        ["GET", "/pay/:checkoutToken"],
        ["POST", "/pay/:checkoutToken/quotes"],
        ["GET", "/pay/:checkoutToken/status"],
        ["GET", "/v1/merchant-wallets"],
        ["POST", "/v1/merchant-wallets"],
        ["POST", "/v1/merchant-wallets/challenges"],
        ["POST", "/v1/merchant-wallets/:walletId/replacement-challenges"],
        ["POST", "/v1/merchant-wallets/:walletId/replace"],
        ["GET", "/v1/operations/production-control"],
        ["GET", "/v1/operations/health"],
        ["GET", "/v1/operations/incidents"],
        ["GET", "/v1/operations/incidents/:incidentId/history"],
        ["POST", "/v1/operations/incidents/:incidentId/acknowledge"],
        ["POST", "/v1/operations/incidents/:incidentId/resolve"],
        ["POST", "/v1/operations/production-control/promote"],
      ] as const) {
        expect(server.hasRoute({ method, url }), `${method} ${url}`).toBe(true);
      }
    } finally {
      await server.close();
    }
  });

  it("applies the global trusted-origin boundary to operational mutations", async () => {
    const server = buildApiServer(config(), {
      emailDelivery: { send: async () => undefined },
    });
    try {
      const response = await server.inject({
        method: "POST",
        url: "/v1/operations/production-control/promote",
        headers: {
          cookie: "payops.session_token=untrusted",
          origin: "https://attacker.example",
          "idempotency-key": "promotion-origin-test-0001",
        },
        payload: { confirmed: true, expectedVersion: 1 },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: "untrusted_origin" });
    } finally {
      await server.close();
    }
  });

  it("registers public analysis routes only when explicitly enabled", async () => {
    const disabled = buildApiServer(config(), {
      emailDelivery: { send: async () => undefined },
    });
    const enabled = buildApiServer(
      {
        ...config(),
        publicAnalysis: {
          clientDigestSecret: Buffer.alloc(32, 4).toString("base64url"),
          clientLimit: 5,
          globalLimit: 100,
          windowSeconds: 60,
        },
      },
      { emailDelivery: { send: async () => undefined } },
    );
    try {
      expect(
        disabled.hasRoute({
          method: "POST",
          url: "/v1/public/wallet-analysis",
        }),
      ).toBe(false);
      expect(
        enabled.hasRoute({
          method: "POST",
          url: "/v1/public/wallet-analysis",
        }),
      ).toBe(true);
      expect(
        enabled.hasRoute({
          method: "OPTIONS",
          url: "/v1/public/wallet-analysis",
        }),
      ).toBe(true);
    } finally {
      await Promise.all([disabled.close(), enabled.close()]);
    }
  });
});

function config(): ApiConfig {
  return {
    databaseUrl: "postgresql://payops:payops@127.0.0.1:55432/payops_test",
    productionControlDatabaseUrl:
      "postgresql://payops:payops@127.0.0.1:55432/payops_test",
    readinessVerifierDatabaseUrl:
      "postgresql://payops:payops@127.0.0.1:55432/payops_test",
    environment: "test",
    publicApiOrigin: "http://127.0.0.1:3000",
    checkoutOrigin: "http://127.0.0.1:3001",
    trustedOrigins: ["http://127.0.0.1:3000"],
    walletProofDomain: "payops.test",
    solanaCluster: "mainnet-beta",
    solanaRpcUrl: "https://api.mainnet-beta.solana.com",
    ingestionProviderId: "mainnet-primary",
    rpc: {
      mode: "dual_provider",
      cluster: "mainnet-beta",
      primary: {
        providerId: "mainnet-primary",
        endpointEnvironment: "TEST_RPC_URL",
        endpoint: "https://api.mainnet-beta.solana.com",
      },
      secondary: {
        providerId: "mainnet-secondary",
        endpointEnvironment: "TEST_SECONDARY_RPC_URL",
        endpoint: "https://secondary.mainnet.example",
      },
    },
    authSecrets: ["uJ9pN3qR8vL2sX6cB5mK7wF4hT1yD0eG9aC8zQ2oI6E"],
    checkoutTokenKeys: [
      {
        id: "checkout-v1",
        secret: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
      },
    ],
    pythHermesEndpoint: "https://pyth.example/hermes",
    pythAccessToken: "test-provider-secret",
    pythFeedIds: { USDC: "a".repeat(64), USDT: "b".repeat(64) },
    ecbEndpoint: "https://data.example/service",
    emailDeliveryMode: "test",
    rateLimitMax: 600,
    rateLimitWindowSeconds: 60,
  };
}
