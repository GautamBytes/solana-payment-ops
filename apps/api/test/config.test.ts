import { describe, expect, test } from "vitest";
import { parseApiConfig } from "../src/config.js";

const validEnvironment = {
  DATABASE_URL: "postgres://payops:payops@127.0.0.1:55432/payops_test",
  PAYOPS_ENVIRONMENT: "local",
  PAYOPS_PUBLIC_API_ORIGIN: "http://127.0.0.1:3000",
  PAYOPS_TRUSTED_ORIGINS: "http://127.0.0.1:3000",
  PAYOPS_WALLET_PROOF_DOMAIN: "payops.local",
  PAYOPS_SOLANA_CLUSTER: "mainnet-beta",
  PAYOPS_SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com",
  PAYOPS_INGESTION_PROVIDER_ID: "mainnet-primary",
  BETTER_AUTH_SECRETS:
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA,AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
  PAYOPS_EMAIL_DELIVERY_MODE: "test",
};

describe("API configuration", () => {
  test("parses the explicit local configuration", () => {
    const config = parseApiConfig(validEnvironment);
    expect(config.environment).toBe("local");
    expect(config.authSecrets).toHaveLength(2);
    expect(config).toMatchObject({
      rateLimitMax: 600,
      rateLimitWindowSeconds: 60,
    });
  });

  test.each([
    [
      {
        PAYOPS_ENVIRONMENT: "production",
        PAYOPS_PUBLIC_API_ORIGIN: "http://api.example.com",
      },
      "unsafe_api_origin",
    ],
    [{ PAYOPS_RATE_LIMIT_MAX: "0" }, "invalid_rate_limit_configuration"],
    [
      { PAYOPS_RATE_LIMIT_WINDOW_SECONDS: "3601" },
      "invalid_rate_limit_configuration",
    ],
    [
      { PAYOPS_TRUSTED_ORIGINS: "https://*.example.com" },
      "invalid_trusted_origin",
    ],
    [{ PAYOPS_SOLANA_CLUSTER: "devnet" }, "unsupported_solana_cluster"],
    [{ BETTER_AUTH_SECRETS: "short" }, "invalid_auth_secret"],
    [
      {
        BETTER_AUTH_SECRETS: `${validEnvironment.BETTER_AUTH_SECRETS.split(",")[0]},${validEnvironment.BETTER_AUTH_SECRETS.split(",")[0]}`,
      },
      "duplicate_auth_secret",
    ],
    [
      {
        PAYOPS_TRUSTED_ORIGINS: "http://127.0.0.1:3000,http://127.0.0.1:3000",
      },
      "duplicate_trusted_origin",
    ],
  ])("rejects unsafe configuration with a bounded code", (override, code) => {
    expect(() => parseApiConfig({ ...validEnvironment, ...override })).toThrow(
      expect.objectContaining({ code }),
    );
  });
});
