import { describe, expect, test, vi } from "vitest";
import { createPayOpsClient, PayOpsApiError } from "../src/index.js";

const REQUEST_ID = "123e4567-e89b-42d3-a456-426614174000";
const RESOURCE_ID = "123e4567-e89b-42d3-a456-426614174001";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "x-request-id": REQUEST_ID },
  });
}

describe("PayOps SDK", () => {
  test("is side-effect free and requires an exact HTTPS origin", () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = createPayOpsClient({
      baseUrl: "https://api.example.com",
      fetch,
    });
    expect(client.baseUrl).toBe("https://api.example.com");
    expect(fetch).not.toHaveBeenCalled();
    for (const value of [
      "http://api.example.com",
      "https://api.example.com/",
      "https://api.example.com/v1",
      "https://user@api.example.com",
    ]) {
      expect(() => createPayOpsClient({ baseUrl: value, fetch })).toThrow(
        "invalid_base_url",
      );
    }
  });

  test("builds authenticated list requests with encoded cursors", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(json({ data: [], nextCursor: null }));
    const client = createPayOpsClient({
      baseUrl: "https://api.example.com",
      apiKey: "secret-key",
      fetch,
    });
    await client.listInvoices({
      requestId: REQUEST_ID,
      limit: 25,
      cursor: "cursor+a+b/==0000",
      status: "issued",
      customerId: RESOURCE_ID,
    });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      `https://api.example.com/v1/invoices?limit=25&cursor=cursor%2Ba%2Bb%2F%3D%3D0000&status=issued&customerId=${RESOURCE_ID}`,
    );
    expect(init?.method).toBe("GET");
    const headers = new Headers(init?.headers);
    expect(headers.get("x-api-key")).toBe("secret-key");
    expect(headers.get("x-request-id")).toBe(REQUEST_ID);
    expect(headers.get("idempotency-key")).toBeNull();
  });

  test("sends canonical mutation headers and never retries failures", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      json(
        {
          code: "conflict",
          message: "Already exists",
          requestId: REQUEST_ID,
        },
        409,
      ),
    );
    const client = createPayOpsClient({
      baseUrl: "https://api.example.com",
      fetch,
    });
    const promise = client.createCustomer(
      { displayName: "Acme" },
      { requestId: REQUEST_ID, idempotencyKey: "customer-create-42" },
    );
    await expect(promise).rejects.toMatchObject({
      status: 409,
      code: "conflict",
      requestId: REQUEST_ID,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [, init] = fetch.mock.calls[0] ?? [];
    expect(init?.body).toBe('{"displayName":"Acme"}');
    expect(new Headers(init?.headers).get("idempotency-key")).toBe(
      "customer-create-42",
    );
  });

  test("uses typed paths and an empty issue body", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(json({ invoice: {}, snapshot: {} }));
    const client = createPayOpsClient({
      baseUrl: "https://api.example.com",
      fetch,
    });
    await client.issueInvoice(RESOURCE_ID, {
      requestId: REQUEST_ID,
      idempotencyKey: "issue-invoice-0001",
    });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      `https://api.example.com/v1/invoices/${RESOURCE_ID}/issue`,
    );
    expect(init?.body).toBe("{}");
  });

  test("creates hosted checkout links and exact payment attempts", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        json(
          {
            checkoutId: RESOURCE_ID,
            checkoutUrl: "https://pay.example.com/pay/capability",
            createdAt: "2026-08-12T12:00:00.000Z",
          },
          201,
        ),
      )
      .mockResolvedValueOnce(
        json({ publicAttemptId: RESOURCE_ID, assetSymbol: "USDC" }, 201),
      );
    const client = createPayOpsClient({
      baseUrl: "https://api.example.com",
      apiKey: "secret-key",
      fetch,
    });
    await client.createCheckoutLink(RESOURCE_ID, { requestId: REQUEST_ID });
    await client.createPaymentAttempt(
      RESOURCE_ID,
      { assetSymbol: "USDC" },
      { requestId: REQUEST_ID },
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    const [linkUrl, linkInit] = fetch.mock.calls[0] ?? [];
    const [attemptUrl, attemptInit] = fetch.mock.calls[1] ?? [];
    expect(String(linkUrl)).toBe(
      `https://api.example.com/v1/invoices/${RESOURCE_ID}/checkout-links`,
    );
    expect(String(attemptUrl)).toBe(
      `https://api.example.com/v1/invoices/${RESOURCE_ID}/payment-attempts`,
    );
    expect(linkInit?.body).toBe("{}");
    expect(attemptInit?.body).toBe('{"assetSymbol":"USDC"}');
    expect(new Headers(linkInit?.headers).get("idempotency-key")).toBeNull();
  });

  test("rejects invalid identifiers and header injection before fetch", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = createPayOpsClient({
      baseUrl: "https://api.example.com",
      fetch,
    });
    expect(() => client.getInvoice("../other")).toThrow("invalid_resource_id");
    await expect(
      client.createCustomer(
        { displayName: "Acme" },
        { idempotencyKey: "valid\r\nX-Evil: yes" },
      ),
    ).rejects.toThrow("invalid_idempotency_key");
    expect(fetch).not.toHaveBeenCalled();
  });

  test("maps malformed and oversized responses to bounded typed errors", async () => {
    const malformed = createPayOpsClient({
      baseUrl: "https://api.example.com",
      fetch: async () =>
        new Response("not-json", {
          headers: { "content-type": "application/json" },
        }),
    });
    await expect(malformed.getOrganization()).rejects.toMatchObject({
      code: "invalid_api_response",
    });

    const oversized = createPayOpsClient({
      baseUrl: "https://api.example.com",
      fetch: async () => json({ value: "x".repeat(1_048_576) }),
    });
    await expect(oversized.getOrganization()).rejects.toMatchObject({
      code: "response_too_large",
    });
  });

  test("preserves caller cancellation and applies a bounded timeout", async () => {
    const fetch: typeof globalThis.fetch = async (_input, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        signal?.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    const client = createPayOpsClient({
      baseUrl: "https://api.example.com",
      fetch,
      timeoutMs: 10,
    });
    await expect(client.getOrganization()).rejects.toBeDefined();

    const controller = new AbortController();
    controller.abort(new Error("caller_cancelled"));
    await expect(
      client.getOrganization({ signal: controller.signal }),
    ).rejects.toThrow("caller_cancelled");
  });

  test("exports a safe API error without retaining raw bodies or credentials", () => {
    const error = new PayOpsApiError({
      status: 401,
      code: "authentication_required",
      message: "Authentication is required",
      requestId: REQUEST_ID,
    });
    expect(JSON.stringify(error)).not.toContain("secret");
    expect(error).toBeInstanceOf(Error);
  });
});
