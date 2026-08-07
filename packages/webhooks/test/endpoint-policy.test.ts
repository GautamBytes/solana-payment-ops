import { describe, expect, it } from "vitest";
import { assertPublicAddress, validateEndpointUrl } from "../src/index.js";

const testOnlyUnsafeAddressPolicy = {
  allowUnsafeAddressesForTesting: true,
} as const;

function expectUnsafeEndpoint(input: string): void {
  expect(() => validateEndpointUrl(input)).toThrowError(
    expect.objectContaining({ code: "unsafe_endpoint" }),
  );
}

function expectUnsafeAddress(address: string): void {
  expect(() => assertPublicAddress(address)).toThrowError(
    expect.objectContaining({ code: "unsafe_endpoint" }),
  );
}

describe("validateEndpointUrl", () => {
  it("normalizes a HTTPS endpoint on port 443", () => {
    expect(validateEndpointUrl("https://hooks.example.com/payops").url).toBe(
      "https://hooks.example.com/payops",
    );
    expect(
      validateEndpointUrl("https://hooks.example.com:443/payops").url,
    ).toBe("https://hooks.example.com/payops");
    expect(validateEndpointUrl("HTTPS://hooks.example.com/payops").url).toBe(
      "https://hooks.example.com/payops",
    );
    expect(
      validateEndpointUrl("https://[2001:4860:4860::8888]:443/hook").url,
    ).toBe("https://[2001:4860:4860::8888]/hook");
  });

  it.each([
    "http://hooks.example.com/payops",
    "https:hooks.example.com/x",
    "https:/hooks.example.com/x",
    "https:///hooks.example.com/x",
    "https:////hooks.example.com/x",
    "https:\\\\hooks.example.com/x",
    "https:/\\hooks.example.com/x",
    "https://\\hooks.example.com/x",
    "https://hooks.example.com\\x",
    "https:///@hooks.example.com/x",
    "https:///[::ffff:8.8.8.8]/x",
    "https://[::ffff:8.8.8.8]:/hook",
    "https://hooks.example.com:/hook",
    "https://[2001:4860:4860::8888]:/hook",
    "https://hooks.example.com:0443/hook",
    "https://[2001:4860:4860::8888]:0443/hook",
    "https://[2001:4860:4860::8888/hook",
    "https://2001:4860:4860::8888]/hook",
    "https://[2001:4860:4860::8888]]/hook",
    "https://[2001:4860:4860::8888]:443junk/hook",
    "https://hooks.example.com::443/hook",
    "https://hooks.example.com:443:443/hook",
    "https://:443/hook",
    "https://[]:443/hook",
    "https://hooks.example.com:8443/payops",
    "https://user@hooks.example.com/payops",
    "https://user:pass@hooks.example.com/payops",
    "https://@hooks.example.com/payops",
    "https://:@hooks.example.com/payops",
    " https://@hooks.example.com/payops",
    "\nhttps://@hooks.example.com/payops",
    "https:\t//hooks.example.com/payops",
    "\u0000https://hooks.example.com/payops",
    "\u001fhttps://hooks.example.com/payops",
    "https://hooks.example.com/payops\u007f",
    "https://hooks.example.com/payops#fragment",
    "https://hooks.example.com/hook#",
    "https://localhost/payops",
    "https://LOCALHOST/payops",
    "https://localhost./payops",
    "https://foo.localhost/payops",
    "https://foo.LOCALHOST/payops",
    "https://localhost.localhost/payops",
    "https://-invalid.example/payops",
    "https://hooks..example/payops",
  ])("rejects unsafe endpoint URL %s", (input) => {
    expectUnsafeEndpoint(input);
  });

  it.each([
    "https://127.0.0.1/hook",
    "https://10.0.0.1/hook",
    "https://169.254.1.1/hook",
    "https://100.64.0.1/hook",
    "https://192.0.2.1/hook",
    "https://198.51.100.1/hook",
    "https://203.0.113.1/hook",
    "https://[::1]/hook",
    "https://[fc00::1]/hook",
    "https://[fe80::1]/hook",
    "https://[ff02::1]/hook",
    "https://[2001:db8::1]/hook",
    "https://[::8.8.8.8]/hook",
    "https://[::ffff:8.8.8.8]/hook",
    "https://[::ffff:10.0.0.1]/hook",
  ])("rejects an unsafe literal address in %s", (input) => {
    expectUnsafeEndpoint(input);
  });

  it("permits a private address only with the explicit test policy", () => {
    expect(
      validateEndpointUrl("https://127.0.0.1/hook", testOnlyUnsafeAddressPolicy)
        .url,
    ).toBe("https://127.0.0.1/hook");
  });
});

describe("assertPublicAddress", () => {
  it.each(["8.8.8.8", "2001:4860:4860::8888", "2606:4700:4700::1111"])(
    "accepts public address %s",
    (address) => {
      expect(() => assertPublicAddress(address)).not.toThrow();
    },
  );

  it.each([
    "0.0.0.0",
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.0.1",
    "169.254.1.1",
    "100.64.0.1",
    "192.0.2.1",
    "198.51.100.1",
    "203.0.113.1",
    "255.255.255.255",
    "224.0.0.1",
    "::",
    "::1",
    "fc00::1",
    "fe80::1",
    "ff02::1",
    "2001:db8::1",
    "4000::1",
    "8000::1",
    "f000::1",
    "::c0a8:1",
    "::8.8.8.8",
    "::0008.0008.0008.0008",
    "::000000008.8.8.8",
    "::8.8.8.8%eth0",
    "::ffff:8.8.8.8",
    "::ffff:192.168.0.1",
    "2001:4860:4860::8888%eth0",
  ])("rejects unsafe address %s", (address) => {
    expectUnsafeAddress(address);
  });
});
