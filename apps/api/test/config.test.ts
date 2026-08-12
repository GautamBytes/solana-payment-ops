import { describe, expect, test } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { parseApiConfig } from "../src/config.js";

const validEnvironment = {
  DATABASE_URL: "postgres://payops:payops@127.0.0.1:55432/payops_test",
  PAYOPS_ENVIRONMENT: "local",
  PAYOPS_PUBLIC_API_ORIGIN: "http://127.0.0.1:3000",
  PAYOPS_CHECKOUT_ORIGIN: "http://127.0.0.1:3001",
  PAYOPS_TRUSTED_ORIGINS: "http://127.0.0.1:3000",
  PAYOPS_WALLET_PROOF_DOMAIN: "payops.local",
  PAYOPS_SOLANA_CLUSTER: "mainnet-beta",
  PAYOPS_SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com",
  PAYOPS_INGESTION_PROVIDER_ID: "mainnet-primary",
  BETTER_AUTH_SECRETS:
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA,AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
  PAYOPS_EMAIL_DELIVERY_MODE: "test",
  PAYOPS_CHECKOUT_TOKEN_KEYS:
    "checkout-v1:AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
  PAYOPS_PYTH_HERMES_ENDPOINT: "https://pyth.example/hermes",
  PAYOPS_PYTH_ACCESS_TOKEN: "test-provider-secret",
  PAYOPS_PYTH_USDC_FEED_ID: "a".repeat(64),
  PAYOPS_PYTH_USDT_FEED_ID: "b".repeat(64),
  PAYOPS_ECB_ENDPOINT: "https://data.example/service",
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

  test("enables authenticated commercial FX only when both values are present", () => {
    expect(
      parseApiConfig({
        ...validEnvironment,
        PAYOPS_COMMERCIAL_FX_ENDPOINT: "https://fx.example/v1/latest",
        PAYOPS_COMMERCIAL_FX_TOKEN: "commercial-provider-token",
      }).commercialFx,
    ).toEqual({
      endpoint: "https://fx.example/v1/latest",
      accessToken: "commercial-provider-token",
    });
    expect(() =>
      parseApiConfig({
        ...validEnvironment,
        PAYOPS_COMMERCIAL_FX_ENDPOINT: "https://fx.example/v1/latest",
      }),
    ).toThrow(
      expect.objectContaining({ code: "invalid_commercial_fx_configuration" }),
    );
  });

  test("loads an exact PKCS8 evidence signing key and rejects partial configuration", () => {
    const key = generateKeyPairSync("ed25519")
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    expect(
      parseApiConfig({
        ...validEnvironment,
        PAYOPS_EVIDENCE_SIGNING_KEY_ID: "evidence-2026-08",
        PAYOPS_EVIDENCE_SIGNING_PRIVATE_KEY_B64:
          Buffer.from(key).toString("base64"),
      }).evidenceSigning,
    ).toEqual({ keyId: "evidence-2026-08", privateKeyPem: key });
    expect(() =>
      parseApiConfig({
        ...validEnvironment,
        PAYOPS_EVIDENCE_SIGNING_KEY_ID: "evidence-2026-08",
      }),
    ).toThrow(
      expect.objectContaining({
        code: "invalid_evidence_signing_configuration",
      }),
    );
  });

  test("requires evidence signing in production", () => {
    expect(() =>
      parseApiConfig({
        ...validEnvironment,
        PAYOPS_ENVIRONMENT: "production",
        PAYOPS_PUBLIC_API_ORIGIN: "https://api.example.com",
        PAYOPS_CHECKOUT_ORIGIN: "https://pay.example.com",
        PAYOPS_TRUSTED_ORIGINS: "https://app.example.com",
      }),
    ).toThrow(
      expect.objectContaining({
        code: "missing_evidence_signing_configuration",
      }),
    );
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
