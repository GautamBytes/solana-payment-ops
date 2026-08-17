import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerBootstrapAcceptanceRoute } from "../src/routes/bootstrap-acceptance.js";

describe("bootstrap acceptance", () => {
  it("rate limits by client before hashing a password", async () => {
    const hashPassword = vi.fn(async () => "unused-hash");
    const acceptInvitation = vi.fn();
    const sendVerificationEmail = vi.fn();
    const rateLimits = {
      consume: vi.fn(async () => ({
        allowed: false,
        limit: 5,
        remaining: 0,
        retryAfterSeconds: 42,
      })),
    };
    const server = Fastify();
    registerBootstrapAcceptanceRoute(server, {
      trustedOrigins: ["https://app.example.com"],
      clientDigestSecret: Buffer.alloc(32, 7).toString("base64url"),
      rateLimits,
      hashPassword,
      acceptInvitation,
      sendVerificationEmail,
    });

    try {
      const response = await server.inject({
        method: "POST",
        url: "/v1/auth/bootstrap/accept",
        headers: { origin: "https://app.example.com" },
        payload: {
          token: "invitation-token",
          email: "owner@example.com",
          name: "Acme Owner",
          password: "correct horse battery staple",
        },
      });

      expect(response.statusCode).toBe(429);
      expect(response.headers).toMatchObject({
        "retry-after": "42",
        "x-ratelimit-limit": "5",
        "x-ratelimit-remaining": "0",
      });
      expect(response.json()).toMatchObject({ code: "rate_limit_exceeded" });
      expect(rateLimits.consume).toHaveBeenCalledWith({
        clientDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
        now: expect.any(Date),
      });
      expect(hashPassword).not.toHaveBeenCalled();
      expect(acceptInvitation).not.toHaveBeenCalled();
      expect(sendVerificationEmail).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
});
