import { describe, expect, it } from "vitest";
import { signWebhook } from "../src/signing/hmac.js";
import {
  runDeliveryBatch,
  type DeliveryStore,
  type DeliveryTransport,
  type DeliveryTransportRequest,
} from "../src/index.js";
import type {
  ClaimedDelivery,
  CompleteDeliveryInput,
} from "../src/storage/types.js";

const batchNow = new Date("2026-08-07T10:00:00.000Z");
const payload = ' {"kept":"byte-for-byte"}\n';

function claim(
  suffix: string,
  overrides: Partial<ClaimedDelivery> = {},
): ClaimedDelivery {
  return {
    deliveryId: `delivery-${suffix}`,
    leaseToken: `lease-${suffix}`,
    attemptNumber: 1,
    firstAttemptAt: batchNow,
    manualReplay: false,
    manualReplayRecovery: false,
    endpoint: {
      id: `endpoint-${suffix}`,
      url: `https://hooks-${suffix}.example.com/payops`,
      secretEnv: `WEBHOOK_SECRET_${suffix.toUpperCase()}`,
      previousSecretEnv: null,
    },
    event: {
      id: `event-${suffix}`,
      eventType: "invoice.paid",
      payload,
      digest: "0".repeat(64),
      occurredAt: batchNow,
    },
    ...overrides,
  };
}

class FakeStore implements DeliveryStore {
  readonly completions: CompleteDeliveryInput[] = [];
  readonly #completionResults: boolean[];

  public constructor(
    readonly claims: readonly ClaimedDelivery[],
    completionResults: readonly boolean[] = [],
  ) {
    this.#completionResults = [...completionResults];
  }

  public async claimDueDeliveries(): Promise<readonly ClaimedDelivery[]> {
    return this.claims;
  }

  public async completeDelivery(
    input: CompleteDeliveryInput,
  ): Promise<boolean> {
    this.completions.push(input);
    return this.#completionResults.shift() ?? true;
  }
}

class FakeTransport implements DeliveryTransport {
  readonly requests: DeliveryTransportRequest[] = [];
  readonly #results: Array<
    { readonly status: number; readonly retryAfter?: string | null } | Error
  >;

  public constructor(
    results: Array<
      { readonly status: number; readonly retryAfter?: string | null } | Error
    >,
  ) {
    this.#results = results;
  }

  public async send(request: DeliveryTransportRequest) {
    this.requests.push(request);
    const result = this.#results.shift();
    if (result instanceof Error) throw result;
    if (result === undefined) throw new Error("Missing fake response");
    return result;
  }
}

const options = {
  limit: 10,
  leaseMs: 30_000,
  now: () => batchNow,
  random: () => 0.5,
};

describe("runDeliveryBatch", () => {
  it("signs and sends the exact event bytes with the required headers", async () => {
    const delivery = claim("one");
    const store = new FakeStore([delivery]);
    const transport = new FakeTransport([{ status: 204 }]);

    const result = await runDeliveryBatch(
      store,
      transport,
      { WEBHOOK_SECRET_ONE: "test-secret" },
      options,
    );

    expect(transport.requests).toEqual([
      {
        url: delivery.endpoint.url,
        body: payload,
        headers: {
          "content-type": "application/json",
          "payops-delivery-id": delivery.deliveryId,
          "payops-event-id": delivery.event.id,
          "payops-signature": signWebhook(payload, "1786096800", "test-secret"),
          "payops-timestamp": "1786096800",
        },
      },
    ]);
    expect(store.completions).toEqual([
      {
        deliveryId: delivery.deliveryId,
        leaseToken: delivery.leaseToken,
        state: "succeeded",
        completedAt: batchNow,
        nextAttemptAt: null,
        httpStatus: 204,
        errorCode: null,
        durationMs: 0,
      },
    ]);
    expect(result).toEqual({
      claimed: 1,
      succeeded: 1,
      retryScheduled: 0,
      dead: 0,
      leaseLost: 0,
    });
    expect(JSON.stringify(result)).not.toContain("test-secret");
    expect(JSON.stringify(store.completions)).not.toContain("test-secret");
  });

  it("schedules a retry for retryable HTTP responses and bounded Retry-After", async () => {
    const delivery = claim("retry");
    const store = new FakeStore([delivery]);
    const transport = new FakeTransport([{ status: 429, retryAfter: "86400" }]);

    const result = await runDeliveryBatch(
      store,
      transport,
      { WEBHOOK_SECRET_RETRY: "retry-secret" },
      options,
    );

    expect(store.completions).toEqual([
      expect.objectContaining({
        state: "retry_wait",
        nextAttemptAt: new Date("2026-08-07T11:00:00.000Z"),
        httpStatus: 429,
        errorCode: "http_429",
      }),
    ]);
    expect(result).toMatchObject({ retryScheduled: 1, dead: 0 });
  });

  it("marks non-retryable HTTP responses dead", async () => {
    const delivery = claim("bad");
    const store = new FakeStore([delivery]);
    const transport = new FakeTransport([{ status: 422 }]);

    const result = await runDeliveryBatch(
      store,
      transport,
      { WEBHOOK_SECRET_BAD: "bad-secret" },
      options,
    );

    expect(store.completions).toEqual([
      expect.objectContaining({
        state: "dead",
        nextAttemptAt: null,
        httpStatus: 422,
        errorCode: "http_422",
      }),
    ]);
    expect(result).toMatchObject({ retryScheduled: 0, dead: 1 });
  });

  it("maps transport failures to bounded safe codes", async () => {
    const delivery = claim("network");
    const store = new FakeStore([delivery]);
    const error = Object.assign(new Error("contains secret-secret-value"), {
      code: "UND_ERR_CONNECT_TIMEOUT",
    });
    const transport = new FakeTransport([error]);

    const result = await runDeliveryBatch(
      store,
      transport,
      { WEBHOOK_SECRET_NETWORK: "secret-secret-value" },
      options,
    );

    expect(store.completions).toEqual([
      expect.objectContaining({
        state: "retry_wait",
        httpStatus: null,
        errorCode: "connect_timeout",
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain("secret-secret-value");
    expect(JSON.stringify(store.completions)).not.toContain(
      "secret-secret-value",
    );
  });

  it.each([
    "body_timeout",
    "connect_timeout",
    "connection_failed",
    "dns_failed",
    "headers_timeout",
    "invalid_response",
    "network_error",
    "response_too_large",
    "tls_failed",
    "total_timeout",
    "unsafe_endpoint",
  ])("preserves the transport's bounded safe code %s", async (code) => {
    const delivery = claim(code);
    const store = new FakeStore([delivery]);
    const transport = new FakeTransport([
      Object.assign(new Error("untrusted detail"), { code }),
    ]);

    await runDeliveryBatch(
      store,
      transport,
      { [delivery.endpoint.secretEnv]: "test-secret" },
      options,
    );

    expect(store.completions).toEqual([
      expect.objectContaining({ errorCode: code, httpStatus: null }),
    ]);
  });

  it.each([
    ["missing", {}, "missing_secret"],
    ["empty", { WEBHOOK_SECRET_EMPTY: "" }, "empty_secret"],
  ] as const)(
    "fails a %s current secret without sending or exposing values",
    async (suffix, env, errorCode) => {
      const delivery = claim(suffix);
      const store = new FakeStore([delivery]);
      const transport = new FakeTransport([]);

      const result = await runDeliveryBatch(store, transport, env, options);

      expect(transport.requests).toEqual([]);
      expect(store.completions).toEqual([
        expect.objectContaining({
          state: "dead",
          httpStatus: null,
          errorCode,
        }),
      ]);
      expect(result).toMatchObject({ dead: 1 });
      expect(JSON.stringify(result)).not.toContain(delivery.endpoint.secretEnv);
    },
  );

  it("does not resolve a secret through the environment object's prototype", async () => {
    const delivery = claim("inherited");
    const store = new FakeStore([delivery]);
    const transport = new FakeTransport([]);
    const env = Object.create({
      WEBHOOK_SECRET_INHERITED: "prototype-secret",
    }) as Record<string, string | undefined>;

    await runDeliveryBatch(store, transport, env, options);

    expect(transport.requests).toEqual([]);
    expect(store.completions).toEqual([
      expect.objectContaining({ state: "dead", errorCode: "missing_secret" }),
    ]);
  });

  it("counts a rejected completion as a lost lease, not success", async () => {
    const delivery = claim("stale");
    const store = new FakeStore([delivery], [false]);
    const transport = new FakeTransport([{ status: 200 }]);

    const result = await runDeliveryBatch(
      store,
      transport,
      { WEBHOOK_SECRET_STALE: "test-secret" },
      options,
    );

    expect(store.completions[0]).toMatchObject({
      deliveryId: delivery.deliveryId,
      leaseToken: delivery.leaseToken,
    });
    expect(result).toEqual({
      claimed: 1,
      succeeded: 0,
      retryScheduled: 0,
      dead: 0,
      leaseLost: 1,
    });
  });

  it("stops retryable deliveries when their retry budget is exhausted", async () => {
    const delivery = claim("exhausted", { attemptNumber: 12 });
    const store = new FakeStore([delivery]);
    const transport = new FakeTransport([{ status: 503 }]);

    await runDeliveryBatch(
      store,
      transport,
      { WEBHOOK_SECRET_EXHAUSTED: "test-secret" },
      options,
    );

    expect(store.completions).toEqual([
      expect.objectContaining({
        state: "dead",
        nextAttemptAt: null,
        httpStatus: 503,
        errorCode: "retry_exhausted",
      }),
    ]);
  });

  it.each([
    ["exact-cutoff", 2, new Date("2026-08-04T10:00:00.000Z")],
    ["past-cutoff", 2, new Date("2026-08-04T09:59:59.999Z")],
    ["attempt-thirteen", 13, batchNow],
  ] as const)(
    "does not automatically send %s work outside its retry budget",
    async (suffix, attemptNumber, firstAttemptAt) => {
      const delivery = claim(suffix, { attemptNumber, firstAttemptAt });
      const store = new FakeStore([delivery]);
      const transport = new FakeTransport([]);
      let secretReads = 0;
      const env = Object.defineProperty({}, delivery.endpoint.secretEnv, {
        enumerable: true,
        get() {
          secretReads += 1;
          return "must-not-be-read";
        },
      });

      const result = await runDeliveryBatch(store, transport, env, options);

      expect(secretReads).toBe(0);
      expect(transport.requests).toEqual([]);
      expect(store.completions).toEqual([
        expect.objectContaining({
          state: "dead",
          errorCode: "retry_exhausted",
        }),
      ]);
      expect(result).toMatchObject({ claimed: 1, dead: 1 });
    },
  );

  it("allows one explicitly replayed delivery beyond the automatic budget", async () => {
    const delivery = claim("manual", {
      attemptNumber: 13,
      firstAttemptAt: batchNow,
      manualReplay: true,
    });
    const store = new FakeStore([delivery]);
    const transport = new FakeTransport([{ status: 204 }]);

    const result = await runDeliveryBatch(
      store,
      transport,
      { WEBHOOK_SECRET_MANUAL: "manual-secret" },
      options,
    );

    expect(transport.requests).toHaveLength(1);
    expect(store.completions).toEqual([
      expect.objectContaining({ state: "succeeded", errorCode: null }),
    ]);
    expect(result).toMatchObject({ succeeded: 1, dead: 0 });
  });

  it.each([
    [{ status: 500 }, "http_500"],
    [new Error("receiver unavailable"), "network_error"],
  ] as const)(
    "never schedules an automatic retry after a manual replay failure",
    async (transportResult, errorCode) => {
      const delivery = claim("manual_failure", {
        attemptNumber: 2,
        firstAttemptAt: new Date("2026-08-04T00:00:00.000Z"),
        manualReplay: true,
      });
      const store = new FakeStore([delivery]);
      const transport = new FakeTransport([transportResult]);

      const result = await runDeliveryBatch(
        store,
        transport,
        { WEBHOOK_SECRET_MANUAL_FAILURE: "manual-secret" },
        options,
      );

      expect(transport.requests).toHaveLength(1);
      expect(store.completions).toEqual([
        expect.objectContaining({
          state: "dead",
          nextAttemptAt: null,
          errorCode,
        }),
      ]);
      expect(result).toMatchObject({ retryScheduled: 0, dead: 1 });
    },
  );

  it("terminalizes an expired manual-replay lease without another send", async () => {
    const delivery = claim("manual_expired", {
      attemptNumber: 3,
      manualReplayRecovery: true,
    });
    const store = new FakeStore([delivery]);
    const transport = new FakeTransport([]);

    const result = await runDeliveryBatch(
      store,
      transport,
      { WEBHOOK_SECRET_MANUAL_EXPIRED: "must-not-be-used" },
      options,
    );

    expect(transport.requests).toEqual([]);
    expect(store.completions).toEqual([
      expect.objectContaining({
        state: "dead",
        nextAttemptAt: null,
        errorCode: "manual_replay_lease_expired",
      }),
    ]);
    expect(result).toMatchObject({ retryScheduled: 0, dead: 1 });
  });

  it("starts later claimed sends without waiting for a slow first request", async () => {
    let releaseFirst!: () => void;
    const firstResponse = new Promise<{ status: number }>((resolve) => {
      releaseFirst = () => resolve({ status: 204 });
    });
    const requests: DeliveryTransportRequest[] = [];
    const transport: DeliveryTransport = {
      async send(request) {
        requests.push(request);
        return requests.length === 1 ? firstResponse : { status: 204 };
      },
    };
    const store = new FakeStore([claim("slow"), claim("fast")]);
    const deliveryPromise = runDeliveryBatch(
      store,
      transport,
      {
        WEBHOOK_SECRET_SLOW: "slow-secret",
        WEBHOOK_SECRET_FAST: "fast-secret",
      },
      { ...options, concurrency: 2 },
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(requests).toHaveLength(2);

    releaseFirst();
    await expect(deliveryPromise).resolves.toMatchObject({ succeeded: 2 });
  });

  it("handles hostile transport error property access without leaking or aborting", async () => {
    const hostile = new Proxy(
      {},
      {
        get(_target, property) {
          if (property === "code") throw new Error("secret-in-getter");
          return undefined;
        },
        has(_target, property) {
          if (property === "code") return true;
          return false;
        },
      },
    );
    const transport: DeliveryTransport = {
      async send() {
        throw hostile;
      },
    };
    const store = new FakeStore([claim("hostile")]);

    const result = await runDeliveryBatch(
      store,
      transport,
      { WEBHOOK_SECRET_HOSTILE: "secret-in-getter" },
      options,
    );

    expect(store.completions).toEqual([
      expect.objectContaining({
        state: "retry_wait",
        errorCode: "network_error",
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain("secret-in-getter");
  });

  it("waits for started workers to settle before surfacing a fatal store error", async () => {
    const databaseError = new Error("database completion failed");
    let releasePending!: () => void;
    const pendingResponse = new Promise<{ status: number }>((resolve) => {
      releasePending = () => resolve({ status: 204 });
    });
    const requests: DeliveryTransportRequest[] = [];
    const transport: DeliveryTransport = {
      async send(request) {
        requests.push(request);
        return requests.length === 2 ? pendingResponse : { status: 204 };
      },
    };
    const store: DeliveryStore = {
      async claimDueDeliveries() {
        return [claim("fatal"), claim("pending"), claim("unstarted")];
      },
      async completeDelivery(input) {
        if (input.deliveryId === "delivery-fatal") throw databaseError;
        return true;
      },
    };
    const batch = runDeliveryBatch(
      store,
      transport,
      {
        WEBHOOK_SECRET_FATAL: "fatal-secret",
        WEBHOOK_SECRET_PENDING: "pending-secret",
        WEBHOOK_SECRET_UNSTARTED: "unstarted-secret",
      },
      { ...options, concurrency: 2 },
    );
    let rejected = false;
    void batch.catch(() => {
      rejected = true;
    });

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(requests).toHaveLength(2);
    expect(rejected).toBe(false);

    releasePending();
    await expect(batch).rejects.toBe(databaseError);
    expect(requests.map((request) => request.url)).not.toContain(
      "https://hooks-unstarted.example.com/payops",
    );
    const settledRequestCount = requests.length;
    await Promise.resolve();
    expect(requests).toHaveLength(settledRequestCount);
  });

  it("reports mixed batch outcomes without payloads or secrets", async () => {
    const store = new FakeStore([
      claim("success"),
      claim("retry"),
      claim("dead"),
    ]);
    const transport = new FakeTransport([
      { status: 200 },
      { status: 500 },
      { status: 400 },
    ]);
    const env = {
      WEBHOOK_SECRET_SUCCESS: "success-secret",
      WEBHOOK_SECRET_RETRY: "retry-secret",
      WEBHOOK_SECRET_DEAD: "dead-secret",
    };

    const result = await runDeliveryBatch(store, transport, env, options);

    expect(result).toEqual({
      claimed: 3,
      succeeded: 1,
      retryScheduled: 1,
      dead: 1,
      leaseLost: 0,
    });
    expect(JSON.stringify(result)).not.toMatch(/secret|payload|event-/i);
  });
});
