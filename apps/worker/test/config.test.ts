import { describe, expect, it } from "vitest";
import { rpcProviderConfigurationIdentity } from "@payops/platform";
import { parseWorkerConfig } from "../src/config.js";

const localEnvironment = {
  DATABASE_URL: "postgresql://worker:secret@db.example/payops",
  PAYOPS_SHADOW_PROJECTOR_DATABASE_URL:
    "postgresql://projector:secret@db.example/payops",
  PAYOPS_ENVIRONMENT: "local",
  PAYOPS_SOLANA_CLUSTER: "localnet",
  PAYOPS_RPC_MODE: "single_provider",
  PAYOPS_RPC_PRIMARY_PROVIDER_ID: "local-primary",
  PAYOPS_RPC_PRIMARY_ENDPOINT_ENV: "LOCAL_RPC_URL",
  LOCAL_RPC_URL: "http://127.0.0.1:8899",
};

describe("worker configuration", () => {
  it("uses bounded defaults for every required job", () => {
    const config = parseWorkerConfig(localEnvironment);
    expect(config.jobs).toHaveLength(6);
    expect(config.jobs.map(({ name }) => name)).toEqual([
      "ingest_watch_targets",
      "refresh_finality",
      "verify_rpc_consensus",
      "project_payment_status",
      "expire_quotes",
      "send_webhooks",
    ]);
    expect(config.jobs[0]).toMatchObject({
      intervalMs: 2_000,
      batchSize: 50,
      concurrency: 4,
      leaseMs: 30_000,
    });
    expect(config.parserVersion).toBe("0.2.0");
    expect(config.buildRevision).toBe("development");
    expect(config.shadowProjectorDatabaseUrl).toBe(
      "postgresql://projector:secret@db.example/payops",
    );
    expect(config.rpc).toEqual({
      mode: "single_provider",
      cluster: "localnet",
      primary: {
        providerId: "local-primary",
        endpointEnvironment: "LOCAL_RPC_URL",
        endpoint: "http://127.0.0.1:8899",
      },
    });
  });

  it("requires two distinct mainnet providers in production", () => {
    const config = parseWorkerConfig({
      ...localEnvironment,
      PAYOPS_ENVIRONMENT: "production",
      PAYOPS_SOLANA_CLUSTER: "mainnet-beta",
      PAYOPS_RPC_MODE: "dual_provider",
      PAYOPS_RPC_PRIMARY_PROVIDER_ID: "mainnet-primary",
      PAYOPS_RPC_PRIMARY_ENDPOINT_ENV: "MAINNET_PRIMARY_RPC_URL",
      MAINNET_PRIMARY_RPC_URL: "https://primary.rpc.example/v1",
      PAYOPS_RPC_SECONDARY_PROVIDER_ID: "mainnet-secondary",
      PAYOPS_RPC_SECONDARY_ENDPOINT_ENV: "MAINNET_SECONDARY_RPC_URL",
      MAINNET_SECONDARY_RPC_URL: "https://secondary.rpc.example/v1",
    });
    expect(config.rpc.mode).toBe("dual_provider");
    expect(config.rpc.secondary).toMatchObject({
      providerId: "mainnet-secondary",
      endpointEnvironment: "MAINNET_SECONDARY_RPC_URL",
    });
    const identity = rpcProviderConfigurationIdentity(config.rpc);
    expect(identity).toMatchObject({
      primaryEndpointEnvironment: "MAINNET_PRIMARY_RPC_URL",
      primaryEndpointDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      secondaryEndpointEnvironment: "MAINNET_SECONDARY_RPC_URL",
      secondaryEndpointDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(JSON.stringify(identity)).not.toContain("rpc.example");
  });

  it.each([
    [{ PAYOPS_ENVIRONMENT: "production", PAYOPS_SOLANA_CLUSTER: "localnet" }],
    [{ PAYOPS_ENVIRONMENT: "production", PAYOPS_RPC_MODE: "single_provider" }],
    [{ PAYOPS_RPC_MODE: undefined }],
    [{ PAYOPS_RPC_PRIMARY_PROVIDER_ID: "spaces are invalid" }],
    [{ PAYOPS_RPC_PRIMARY_ENDPOINT_ENV: "lowercase_name" }],
  ])("rejects an invalid deployment/provider contract", (override) => {
    expect(() =>
      parseWorkerConfig({ ...localEnvironment, ...override }),
    ).toThrow("configuration");
  });

  it.each([
    ["PAYOPS_RPC_SECONDARY_PROVIDER_ID", "mainnet-primary"],
    ["PAYOPS_RPC_SECONDARY_ENDPOINT_ENV", "MAINNET_PRIMARY_RPC_URL"],
  ])("rejects duplicate production provider field %s", (name, value) => {
    expect(() =>
      parseWorkerConfig({
        ...localEnvironment,
        PAYOPS_ENVIRONMENT: "production",
        PAYOPS_SOLANA_CLUSTER: "mainnet-beta",
        PAYOPS_RPC_MODE: "dual_provider",
        PAYOPS_RPC_PRIMARY_PROVIDER_ID: "mainnet-primary",
        PAYOPS_RPC_PRIMARY_ENDPOINT_ENV: "MAINNET_PRIMARY_RPC_URL",
        MAINNET_PRIMARY_RPC_URL: "https://primary.rpc.example/v1",
        PAYOPS_RPC_SECONDARY_PROVIDER_ID: "mainnet-secondary",
        PAYOPS_RPC_SECONDARY_ENDPOINT_ENV: "MAINNET_SECONDARY_RPC_URL",
        MAINNET_SECONDARY_RPC_URL: "https://secondary.rpc.example/v1",
        [name]: value,
      }),
    ).toThrow("configuration");
  });

  it.each([
    ["PAYOPS_WORKER_INTERVAL_MS", "249"],
    ["PAYOPS_WORKER_INTERVAL_MS", "60001"],
    ["PAYOPS_WORKER_BATCH_SIZE", "0"],
    ["PAYOPS_WORKER_BATCH_SIZE", "101"],
    ["PAYOPS_WORKER_CONCURRENCY", "17"],
    ["PAYOPS_WORKER_LEASE_MS", "4999"],
    ["PAYOPS_WORKER_LEASE_MS", "120001"],
    ["PAYOPS_WORKER_BATCH_SIZE", "01"],
    ["PAYOPS_BUILD_REVISION", "contains spaces"],
  ])("rejects %s=%s", (name, value) => {
    expect(() =>
      parseWorkerConfig({
        ...localEnvironment,
        [name]: value,
      }),
    ).toThrow("configuration");
  });

  it("does not accept inherited configuration", () => {
    const environment = Object.create(localEnvironment) as NodeJS.ProcessEnv;
    expect(() => parseWorkerConfig(environment)).toThrow(
      "configuration is invalid",
    );
  });

  it("does not resolve endpoint secrets through the prototype chain", () => {
    const environment = Object.assign(
      Object.create({ LOCAL_RPC_URL: "http://evil.example" }),
      localEnvironment,
    ) as NodeJS.ProcessEnv;
    delete environment.LOCAL_RPC_URL;
    expect(() => parseWorkerConfig(environment)).toThrow(
      "configuration is invalid",
    );
  });
});
