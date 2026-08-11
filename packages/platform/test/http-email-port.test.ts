import { describe, expect, it, vi } from "vitest";
import { HttpEmailDeliveryPort } from "../src/auth/http-email-port.js";

describe("HTTP authentication email delivery", () => {
  it("sends a bounded HTTPS relay request without following redirects", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 204 }));
    const port = new HttpEmailDeliveryPort({
      endpoint: "https://email.example.com/v1/auth-email",
      bearerToken: "relay-token-with-at-least-thirty-two-bytes",
      fetch: request,
    });
    await port.send({
      kind: "email_verification",
      to: "owner@example.com",
      actionUrl: "https://app.example.com/verify?token=secret",
      expiresAt: new Date("2026-08-11T13:00:00.000Z"),
    });

    expect(request).toHaveBeenCalledOnce();
    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe("https://email.example.com/v1/auth-email");
    expect(init).toMatchObject({ method: "POST", redirect: "manual" });
    expect((init?.headers as Record<string, string>).authorization).toBe(
      "Bearer relay-token-with-at-least-thirty-two-bytes",
    );
    expect(JSON.parse(String(init?.body))).toMatchObject({
      expiresAt: "2026-08-11T13:00:00.000Z",
    });
  });

  it("fails closed for unsafe configuration, redirects, and transport errors", async () => {
    expect(
      () =>
        new HttpEmailDeliveryPort({
          endpoint: "http://email.example.com/send",
          bearerToken: "relay-token-with-at-least-thirty-two-bytes",
        }),
    ).toThrowError(
      expect.objectContaining({ code: "invalid_email_delivery_configuration" }),
    );

    for (const response of [
      Promise.resolve(new Response("secret provider body", { status: 307 })),
      Promise.reject(new Error("secret transport details")),
      Promise.reject(
        new Proxy(
          {},
          {
            getOwnPropertyDescriptor: () => {
              throw new Error("trap");
            },
          },
        ),
      ),
    ]) {
      const port = new HttpEmailDeliveryPort({
        endpoint: "https://email.example.com/send",
        bearerToken: "relay-token-with-at-least-thirty-two-bytes",
        fetch: vi.fn<typeof fetch>().mockReturnValue(response),
      });
      await expect(
        port.send({
          kind: "password_reset",
          to: "owner@example.com",
          actionUrl: "https://app.example.com/reset?token=secret",
        }),
      ).rejects.toMatchObject({
        code: expect.stringMatching(/^email_delivery_/),
        message: "Authentication email delivery failed",
      });
    }
  });
});
