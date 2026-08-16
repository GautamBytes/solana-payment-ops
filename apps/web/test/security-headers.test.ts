import { describe, expect, test } from "vitest";
import {
  checkoutSecurityHeaders,
  publicPageSecurityHeaders,
} from "../lib/security-headers.js";

const input = {
  nonce: "YWJjZGVmZ2hpamtsbW5vcA==",
  apiOrigin: "https://api.payops.example",
  development: false,
};

describe("web security headers", () => {
  test("indexes public pages while blocking framing and powerful features", () => {
    const headers = publicPageSecurityHeaders(input);
    expect(headers["Content-Security-Policy"]).toContain(
      "frame-ancestors 'none'",
    );
    expect(headers["Content-Security-Policy"]).toContain(
      "connect-src 'self' https://api.payops.example",
    );
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["X-Frame-Options"]).toBe("DENY");
    expect(headers["Permissions-Policy"]).toContain("payment=()");
    expect(headers["X-Robots-Tag"]).toBeUndefined();
    expect(headers["Cache-Control"]).toBeUndefined();
  });

  test("supports the same-origin public analyzer and no-store Try page", () => {
    const headers = publicPageSecurityHeaders({
      nonce: input.nonce,
      development: false,
      noStore: true,
    });
    expect(headers["Content-Security-Policy"]).toContain("connect-src 'self'");
    expect(headers["Content-Security-Policy"]).not.toContain(
      "api.payops.example",
    );
    expect(headers["Cache-Control"]).toBe("private, no-store");
  });

  test("keeps checkout pages out of search and storage", () => {
    const headers = checkoutSecurityHeaders(input);
    expect(headers["X-Robots-Tag"]).toContain("noindex");
    expect(headers["Cache-Control"]).toBe("private, no-store");
  });
});
