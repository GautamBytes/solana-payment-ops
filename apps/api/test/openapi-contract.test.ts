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
        ["GET", "/v1/merchant-wallets"],
        ["POST", "/v1/merchant-wallets"],
        ["POST", "/v1/merchant-wallets/challenges"],
        ["POST", "/v1/merchant-wallets/:walletId/replacement-challenges"],
        ["POST", "/v1/merchant-wallets/:walletId/replace"],
      ] as const) {
        expect(server.hasRoute({ method, url }), `${method} ${url}`).toBe(true);
      }
    } finally {
      await server.close();
    }
  });
});

function config(): ApiConfig {
  return {
    databaseUrl: "postgresql://payops:payops@127.0.0.1:55432/payops_test",
    environment: "test",
    publicApiOrigin: "http://127.0.0.1:3000",
    trustedOrigins: ["http://127.0.0.1:3000"],
    walletProofDomain: "payops.test",
    solanaCluster: "mainnet-beta",
    solanaRpcUrl: "https://api.mainnet-beta.solana.com",
    ingestionProviderId: "mainnet-primary",
    authSecrets: ["uJ9pN3qR8vL2sX6cB5mK7wF4hT1yD0eG9aC8zQ2oI6E"],
    emailDeliveryMode: "test",
    rateLimitMax: 600,
    rateLimitWindowSeconds: 60,
  };
}
