import { describe, expect, it, vi } from "vitest";
import type { DeliveryTransportRequest } from "../src/delivery/worker.js";
import {
  UndiciWebhookTransport,
  WebhookTransportError,
  type PinnedDispatcher,
  type PinnedDispatcherFactoryInput,
  type TransportRequestOptions,
  type TransportResponse,
} from "../src/transport/https-transport.js";
import { UnsafeEndpointError } from "../src/security/endpoint-policy.js";

const deliveryRequest: DeliveryTransportRequest = {
  url: "https://hooks.example.com/payops",
  body: '{"event":"invoice.paid"}',
  headers: { "content-type": "application/json" },
};

function response(
  chunks: readonly Uint8Array[] = [],
  overrides: Partial<TransportResponse> = {},
): TransportResponse {
  return {
    statusCode: 204,
    headers: {},
    body: {
      destroy: vi.fn(),
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) yield chunk;
      },
    },
    ...overrides,
  };
}

function dependencies(options?: {
  readonly addresses?: readonly {
    readonly address: string;
    readonly family: 4 | 6;
  }[];
  readonly result?: TransportResponse;
  readonly error?: unknown;
}) {
  const close = vi.fn(async () => undefined);
  const dispatcher: PinnedDispatcher = { close };
  const resolver = vi.fn(async () =>
    Promise.resolve(
      options?.addresses ?? [
        { address: "8.8.8.8", family: 4 as const },
        { address: "2001:4860:4860::8888", family: 6 as const },
      ],
    ),
  );
  const createDispatcher = vi.fn(
    (_input: PinnedDispatcherFactoryInput) => dispatcher,
  );
  const performRequest = vi.fn(
    async (_url: URL, _requestOptions: TransportRequestOptions) => {
      if (options?.error !== undefined) throw options.error;
      return options?.result ?? response();
    },
  );
  return {
    close,
    createDispatcher,
    dispatcher,
    performRequest,
    resolver,
  };
}

describe("UndiciWebhookTransport", () => {
  it("validates all DNS answers and pins one while retaining the TLS hostname", async () => {
    const deps = dependencies();
    const transport = new UndiciWebhookTransport({}, deps);

    await expect(transport.send(deliveryRequest)).resolves.toEqual({
      status: 204,
      retryAfter: null,
    });

    expect(deps.resolver).toHaveBeenCalledWith("hooks.example.com");
    expect(deps.createDispatcher).toHaveBeenCalledWith({
      address: "8.8.8.8",
      family: 4,
      hostname: "hooks.example.com",
      connectTimeoutMs: 5_000,
      maxResponseBodyBytes: 65_536,
    });
    expect(deps.performRequest).toHaveBeenCalledWith(
      new URL(deliveryRequest.url),
      expect.objectContaining({
        method: "POST",
        body: deliveryRequest.body,
        dispatcher: deps.dispatcher,
        maxRedirections: 0,
        headersTimeout: 10_000,
        bodyTimeout: 10_000,
      }),
    );
    expect(deps.close).toHaveBeenCalledOnce();
  });

  it("fails closed before connecting when any DNS answer is unsafe", async () => {
    const deps = dependencies({
      addresses: [
        { address: "8.8.8.8", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ],
    });
    const transport = new UndiciWebhookTransport({}, deps);

    await expect(transport.send(deliveryRequest)).rejects.toMatchObject({
      code: "unsafe_endpoint",
    });
    expect(deps.createDispatcher).not.toHaveBeenCalled();
    expect(deps.performRequest).not.toHaveBeenCalled();
  });

  it("resolves and revalidates immediately before every delivery", async () => {
    const deps = dependencies();
    const transport = new UndiciWebhookTransport({}, deps);

    await transport.send(deliveryRequest);
    await transport.send(deliveryRequest);

    expect(deps.resolver).toHaveBeenCalledTimes(2);
    expect(deps.createDispatcher).toHaveBeenCalledTimes(2);
    expect(deps.close).toHaveBeenCalledTimes(2);
  });

  it.each(["http://hooks.example.com/payops", "https://127.0.0.1/payops"])(
    "rejects a noncanonical or unsafe endpoint before DNS: %s",
    async (url) => {
      const deps = dependencies();
      const transport = new UndiciWebhookTransport({}, deps);

      await expect(
        transport.send({ ...deliveryRequest, url }),
      ).rejects.toMatchObject({ code: "unsafe_endpoint" });
      expect(deps.resolver).not.toHaveBeenCalled();
    },
  );

  it("returns Retry-After but never follows redirects", async () => {
    const deps = dependencies({
      result: response([], {
        statusCode: 307,
        headers: { "retry-after": "30", location: "https://evil.example" },
      }),
    });
    const transport = new UndiciWebhookTransport({}, deps);

    await expect(transport.send(deliveryRequest)).resolves.toEqual({
      status: 307,
      retryAfter: "30",
    });
    expect(deps.performRequest.mock.calls[0]?.[1].maxRedirections).toBe(0);
  });

  it("stops consuming and destroys an oversized response body", async () => {
    const body = response([new Uint8Array(4), new Uint8Array(5)]).body;
    const deps = dependencies({
      result: { statusCode: 200, headers: {}, body },
    });
    const transport = new UndiciWebhookTransport(
      { maxResponseBodyBytes: 8 },
      deps,
    );

    await expect(transport.send(deliveryRequest)).rejects.toMatchObject({
      code: "response_too_large",
    });
    expect(body.destroy).toHaveBeenCalledOnce();
    expect(deps.close).toHaveBeenCalledOnce();
  });

  it.each([
    ["UND_ERR_CONNECT_TIMEOUT", "connect_timeout"],
    ["UND_ERR_HEADERS_TIMEOUT", "headers_timeout"],
    ["UND_ERR_BODY_TIMEOUT", "body_timeout"],
    ["ENOTFOUND", "dns_failed"],
    ["ECONNREFUSED", "connection_failed"],
    ["ERR_TLS_CERT_ALTNAME_INVALID", "tls_failed"],
  ] as const)("maps %s to the safe code %s", async (sourceCode, safeCode) => {
    const deps = dependencies({
      error: Object.assign(new Error("sensitive network detail"), {
        code: sourceCode,
      }),
    });
    const transport = new UndiciWebhookTransport({}, deps);

    await expect(transport.send(deliveryRequest)).rejects.toMatchObject({
      code: safeCode,
      message: "Webhook delivery failed",
    });
    expect(deps.close).toHaveBeenCalledOnce();
  });

  it.each([
    [
      "getPrototypeOf trap",
      new Proxy(
        {},
        {
          getPrototypeOf() {
            throw new Error("attacker getPrototypeOf detail");
          },
        },
      ),
    ],
    [
      "revoked proxy",
      (() => {
        const pair = Proxy.revocable({}, {});
        pair.revoke();
        return pair.proxy;
      })(),
    ],
    [
      "forged UnsafeEndpointError prototype",
      Object.assign(Object.create(UnsafeEndpointError.prototype), {
        attacker: "forged unsafe detail",
      }),
    ],
    [
      "throwing code getter and coercion",
      Object.defineProperties(
        {},
        {
          code: {
            get() {
              throw new Error("attacker code getter detail");
            },
          },
          [Symbol.toPrimitive]: {
            value() {
              throw new Error("attacker coercion detail");
            },
          },
        },
      ),
    ],
  ])("sanitizes hostile thrown values with a %s", async (_name, hostile) => {
    const deps = dependencies({ error: hostile });
    const transport = new UndiciWebhookTransport({}, deps);

    const error = await transport
      .send(deliveryRequest)
      .catch((caught) => caught);

    expect(error === hostile).toBe(false);
    expect(error).toEqual(
      expect.objectContaining({
        code: "network_error",
        message: "Webhook delivery failed",
      }),
    );
    expect(
      JSON.stringify({ code: error.code, message: error.message }),
    ).not.toContain("attacker");
  });

  it("reconstructs a prototype-forged transport error as a fresh safe error", async () => {
    const forged = Object.assign(
      Object.create(WebhookTransportError.prototype),
      {
        code: "tls_failed",
        message: "attacker transport detail",
      },
    );
    const deps = dependencies({ error: forged });
    const transport = new UndiciWebhookTransport({}, deps);

    const error = await transport
      .send(deliveryRequest)
      .catch((caught) => caught);

    expect(error).not.toBe(forged);
    expect(error).toEqual(
      expect.objectContaining({
        code: "tls_failed",
        message: "Webhook delivery failed",
      }),
    );
  });

  it("derives the total timeout only from its private deadline signal", async () => {
    const deps = dependencies({
      error: { code: "total_timeout", message: "attacker timeout detail" },
    });
    const transport = new UndiciWebhookTransport({}, deps);

    await expect(transport.send(deliveryRequest)).rejects.toMatchObject({
      code: "network_error",
      message: "Webhook delivery failed",
    });
  });

  it("enforces a total deadline and releases the dispatcher", async () => {
    const deps = dependencies();
    deps.performRequest.mockImplementation(
      async (_url, requestOptions) =>
        new Promise((_resolve, reject) => {
          requestOptions.signal.addEventListener(
            "abort",
            () => reject(requestOptions.signal.reason),
            { once: true },
          );
        }),
    );
    const transport = new UndiciWebhookTransport({ totalTimeoutMs: 5 }, deps);

    await expect(transport.send(deliveryRequest)).rejects.toMatchObject({
      code: "total_timeout",
    });
    expect(deps.close).toHaveBeenCalledOnce();
  });

  it("includes DNS resolution in the total deadline", async () => {
    const deps = dependencies();
    deps.resolver.mockImplementation(
      async () =>
        new Promise((resolve) => {
          setTimeout(() => resolve([{ address: "8.8.8.8", family: 4 }]), 25);
        }),
    );
    const transport = new UndiciWebhookTransport({ totalTimeoutMs: 5 }, deps);

    await expect(transport.send(deliveryRequest)).rejects.toMatchObject({
      code: "total_timeout",
    });
    expect(deps.createDispatcher).not.toHaveBeenCalled();
  });

  it("includes response body consumption in the total deadline", async () => {
    const body: TransportResponse["body"] = {
      destroy: vi.fn(),
      [Symbol.asyncIterator]() {
        return {
          async next() {
            return new Promise((resolve) => {
              setTimeout(() => resolve({ done: true, value: undefined }), 25);
            });
          },
        };
      },
    };
    const deps = dependencies({
      result: { statusCode: 204, headers: {}, body },
    });
    const transport = new UndiciWebhookTransport({ totalTimeoutMs: 5 }, deps);

    await expect(transport.send(deliveryRequest)).rejects.toMatchObject({
      code: "total_timeout",
    });
    expect(deps.close).toHaveBeenCalledOnce();
  });

  it("rejects malformed response status values", async () => {
    const deps = dependencies({
      result: response([], { statusCode: 700 }),
    });
    const transport = new UndiciWebhookTransport({}, deps);

    await expect(transport.send(deliveryRequest)).rejects.toMatchObject({
      code: "invalid_response",
    });
  });
});
