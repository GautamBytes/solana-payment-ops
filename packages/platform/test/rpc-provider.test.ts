import { describe, expect, it } from "vitest";
import {
  parseRpcProviderConfiguration,
  rpcProviderConfigurationIdentity,
} from "../src/index.js";

const productionDualEnvironment = {
  PAYOPS_SOLANA_CLUSTER: "mainnet-beta",
  PAYOPS_RPC_MODE: "dual_provider",
  PAYOPS_RPC_PRIMARY_PROVIDER_ID: "mainnet-primary",
  PAYOPS_RPC_PRIMARY_ENDPOINT_ENV: "MAINNET_PRIMARY_RPC_URL",
  MAINNET_PRIMARY_RPC_URL: "https://primary.rpc.example/v1",
  PAYOPS_RPC_SECONDARY_PROVIDER_ID: "mainnet-secondary",
  PAYOPS_RPC_SECONDARY_ENDPOINT_ENV: "MAINNET_SECONDARY_RPC_URL",
  MAINNET_SECONDARY_RPC_URL: "https://secondary.rpc.example/v1",
};

describe("RPC provider configuration", () => {
  it("derives canonical endpoint identities without retaining raw URLs", () => {
    const first = rpcProviderConfigurationIdentity(
      parseRpcProviderConfiguration(
        {
          ...productionDualEnvironment,
          MAINNET_PRIMARY_RPC_URL:
            "https://PRIMARY.RPC.EXAMPLE:443/intermediate/../v1/%7E?redirect=%3fpage",
        },
        "production",
      ),
    );
    const equivalent = rpcProviderConfigurationIdentity(
      parseRpcProviderConfiguration(
        {
          ...productionDualEnvironment,
          MAINNET_PRIMARY_RPC_URL:
            "https://primary.rpc.example/v1/~?redirect=%3Fpage",
        },
        "production",
      ),
    );

    expect(first).toMatchObject({
      primaryProviderId: "mainnet-primary",
      primaryEndpointEnvironment: "MAINNET_PRIMARY_RPC_URL",
      primaryEndpointDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      secondaryProviderId: "mainnet-secondary",
      secondaryEndpointEnvironment: "MAINNET_SECONDARY_RPC_URL",
      secondaryEndpointDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(first.primaryEndpointDigest).toBe(equivalent.primaryEndpointDigest);
    expect(JSON.stringify(first)).not.toContain("primary.rpc.example");
    expect(JSON.stringify(first)).not.toContain("redirect");
  });
  it.each([
    ["the exact same URL", "https://primary.rpc.example/v1"],
    [
      "a canonical-equivalent URL",
      "https://PRIMARY.RPC.EXAMPLE:443/intermediate/../v1",
    ],
    [
      "a URL with percent-encoded unreserved path characters",
      "https://primary.rpc.example/%76%31",
    ],
    [
      "a URL with an equivalent trailing-dot hostname",
      "https://primary.rpc.example./v1",
    ],
  ])("rejects dual providers resolving to %s", (_description, endpoint) => {
    expect(() =>
      parseRpcProviderConfiguration(
        {
          ...productionDualEnvironment,
          MAINNET_SECONDARY_RPC_URL: endpoint,
        },
        "production",
      ),
    ).toThrow(expect.objectContaining({ code: "invalid_rpc_configuration" }));
  });

  it("rejects endpoints with percent-encoded unreserved query characters", () => {
    expect(() =>
      parseRpcProviderConfiguration(
        {
          ...productionDualEnvironment,
          MAINNET_PRIMARY_RPC_URL:
            "https://primary.rpc.example/v1?api_key=token~1",
          MAINNET_SECONDARY_RPC_URL:
            "https://primary.rpc.example/v1?api_key=token%7E1",
        },
        "production",
      ),
    ).toThrow(expect.objectContaining({ code: "invalid_rpc_configuration" }));
  });

  it("rejects endpoints differing only by percent-encoding hex case", () => {
    expect(() =>
      parseRpcProviderConfiguration(
        {
          ...productionDualEnvironment,
          MAINNET_PRIMARY_RPC_URL:
            "https://primary.rpc.example/v1%2Fstatus?redirect=%3Fpage",
          MAINNET_SECONDARY_RPC_URL:
            "https://primary.rpc.example/v1%2fstatus?redirect=%3fpage",
        },
        "production",
      ),
    ).toThrow(expect.objectContaining({ code: "invalid_rpc_configuration" }));
  });

  it("accepts endpoints with distinct encoded and literal path separators", () => {
    expect(() =>
      parseRpcProviderConfiguration(
        {
          ...productionDualEnvironment,
          MAINNET_PRIMARY_RPC_URL: "https://primary.rpc.example/v1%2Fstatus",
          MAINNET_SECONDARY_RPC_URL: "https://primary.rpc.example/v1/status",
        },
        "production",
      ),
    ).not.toThrow();
  });

  it("accepts endpoints with a distinct query parameter order", () => {
    expect(() =>
      parseRpcProviderConfiguration(
        {
          ...productionDualEnvironment,
          MAINNET_PRIMARY_RPC_URL:
            "https://primary.rpc.example/v1?account=one&limit=10",
          MAINNET_SECONDARY_RPC_URL:
            "https://primary.rpc.example/v1?limit=10&account=one",
        },
        "production",
      ),
    ).not.toThrow();
  });

  it("accepts endpoints with distinct absent and empty queries", () => {
    expect(() =>
      parseRpcProviderConfiguration(
        {
          ...productionDualEnvironment,
          MAINNET_PRIMARY_RPC_URL: "https://primary.rpc.example/v1",
          MAINNET_SECONDARY_RPC_URL: "https://primary.rpc.example/v1?",
        },
        "production",
      ),
    ).not.toThrow();
  });

  it.each(["local", "test"] as const)(
    "rejects single-provider mainnet in %s deployments",
    (deploymentEnvironment) => {
      expect(() =>
        parseRpcProviderConfiguration(
          {
            PAYOPS_SOLANA_CLUSTER: "mainnet-beta",
            PAYOPS_RPC_MODE: "single_provider",
            PAYOPS_RPC_PRIMARY_PROVIDER_ID: "mainnet-primary",
            PAYOPS_RPC_PRIMARY_ENDPOINT_ENV: "MAINNET_PRIMARY_RPC_URL",
            MAINNET_PRIMARY_RPC_URL: "https://primary.rpc.example/v1",
          },
          deploymentEnvironment,
        ),
      ).toThrow(expect.objectContaining({ code: "invalid_rpc_configuration" }));
    },
  );
});
