import { afterEach, describe, expect, test, vi } from "vitest";
import { GET as live } from "../app/health/live/route.js";
import { GET as ready } from "../app/health/ready/route.js";
import { parseWebRuntimeConfig } from "../lib/runtime-config.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const validEnvironment = {
  PAYOPS_WEB_ORIGIN: "https://pay.example.com",
  PAYOPS_API_ORIGIN: "https://api.example.com",
  NEXT_PUBLIC_PAYOPS_API_ORIGIN: "https://api.example.com",
};

describe("web container health", () => {
  test("liveness is static, bounded, and never cached", async () => {
    const response = await live();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe('{"status":"ok"}');
  });

  test("readiness accepts exact secure matching origins without network access", async () => {
    for (const [name, value] of Object.entries(validEnvironment)) {
      vi.stubEnv(name, value);
    }
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    const response = await ready();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe('{"status":"ok"}');
    expect(fetch).not.toHaveBeenCalled();
  });

  test("requires the server and browser API origins to match exactly", () => {
    expect(() =>
      parseWebRuntimeConfig({
        PAYOPS_WEB_ORIGIN: "https://payops.example",
        PAYOPS_API_ORIGIN: "https://api.payops.example",
        NEXT_PUBLIC_PAYOPS_API_ORIGIN: "https://api-alt.payops.example",
      }),
    ).toThrow("invalid_web_origin_configuration");
  });

  test.each([
    ["missing", {}],
    [
      "API mismatch",
      {
        ...validEnvironment,
        NEXT_PUBLIC_PAYOPS_API_ORIGIN: "https://other.example.com",
      },
    ],
    [
      "insecure origin",
      { ...validEnvironment, PAYOPS_WEB_ORIGIN: "http://pay.example.com" },
    ],
    [
      "origin path",
      { ...validEnvironment, PAYOPS_API_ORIGIN: "https://api.example.com/v1" },
    ],
    [
      "credentials",
      {
        ...validEnvironment,
        PAYOPS_WEB_ORIGIN: "https://user@pay.example.com",
      },
    ],
  ])("fails closed for %s", async (_name, environment) => {
    for (const [name, value] of Object.entries(environment)) {
      vi.stubEnv(name, value);
    }

    expect(() => parseWebRuntimeConfig(environment)).toThrow(
      "invalid_web_origin_configuration",
    );
    const response = await ready();
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe(
      '{"status":"not_ready","code":"invalid_web_origin_configuration"}',
    );
  });
});
