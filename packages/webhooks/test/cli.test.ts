import { stringifyCanonical } from "@payops/core";
import { describe, expect, it, vi } from "vitest";
import type { DeliveryBatchResult } from "../src/delivery/worker.js";
import type {
  WebhookEndpointRecord,
  WebhookEventInspection,
} from "../src/storage/types.js";
import { runCli, type WebhookCliDependencies } from "../src/cli.js";

const now = new Date("2026-08-07T10:00:00.000Z");

function fixture() {
  const lines: string[] = [];
  const store = {
    addEndpoint: vi.fn(async () => ({ inserted: true })),
    rotateEndpointSecret: vi.fn(async () => ({ rotated: true })),
    listEndpoints: vi.fn(
      async (): Promise<readonly WebhookEndpointRecord[]> => [],
    ),
    replayDelivery: vi.fn(async () => true),
    inspectEvent: vi.fn(
      async (): Promise<WebhookEventInspection | null> => null,
    ),
    claimDueDeliveries: vi.fn(),
    completeDelivery: vi.fn(),
    close: vi.fn(async () => undefined),
  };
  const transport = {
    send: vi.fn(),
    close: vi.fn(async () => undefined),
  };
  const deliveryResult: DeliveryBatchResult = {
    claimed: 0,
    succeeded: 0,
    retryScheduled: 0,
    dead: 0,
    leaseLost: 0,
  };
  const dependencies: WebhookCliDependencies = {
    env: { DATABASE_URL: "postgres://payops", ENDPOINT_SECRET: "do-not-print" },
    write: (line) => lines.push(line),
    now: () => now,
    migrate: vi.fn(async () => undefined),
    createStore: vi.fn(() => store),
    createTransport: vi.fn(() => transport),
    deliver: vi.fn(async () => deliveryResult),
  };
  return { dependencies, lines, store, transport };
}

describe("webhook operator CLI", () => {
  it("runs migrations without opening a store", async () => {
    const { dependencies, lines } = fixture();
    await expect(runCli(["migrate"], dependencies)).resolves.toBe(0);
    expect(dependencies.migrate).toHaveBeenCalledWith("postgres://payops");
    expect(dependencies.createStore).not.toHaveBeenCalled();
    expect(lines).toEqual([stringifyCanonical({ migrated: true }).trimEnd()]);
  });

  it("adds an endpoint and checks its secret reference without exposing the value", async () => {
    const { dependencies, lines, store } = fixture();
    await expect(
      runCli(
        [
          "endpoint",
          "add",
          "--url",
          "https://hooks.example.com/payops",
          "--secret-env",
          "ENDPOINT_SECRET",
          "--id",
          "merchant-a",
        ],
        dependencies,
      ),
    ).resolves.toBe(0);
    expect(store.addEndpoint).toHaveBeenCalledWith(
      {
        id: "merchant-a",
        secretEnv: "ENDPOINT_SECRET",
        url: "https://hooks.example.com/payops",
      },
      now,
    );
    expect(lines.join("\n")).not.toContain("do-not-print");
    expect(store.close).toHaveBeenCalledOnce();
  });

  it("lists endpoints in canonical JSON without resolving or printing secrets", async () => {
    const { dependencies, lines, store } = fixture();
    store.listEndpoints.mockResolvedValue([
      {
        id: "merchant-a",
        url: "https://hooks.example.com/payops",
        secretEnv: "ENDPOINT_SECRET",
        previousSecretEnv: "OLD_ENDPOINT_SECRET",
        state: "active",
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await expect(runCli(["endpoint", "list"], dependencies)).resolves.toBe(0);
    expect(JSON.parse(lines[0]!)).toEqual({
      endpoints: [
        expect.objectContaining({
          createdAt: "2026-08-07T10:00:00.000Z",
          updatedAt: "2026-08-07T10:00:00.000Z",
        }),
      ],
    });
    expect(lines.join("\n")).not.toContain("do-not-print");
  });

  it("rotates endpoint secret references", async () => {
    const { dependencies, store } = fixture();
    await expect(
      runCli(
        [
          "endpoint",
          "rotate-secret",
          "--id",
          "merchant-a",
          "--secret-env",
          "ENDPOINT_SECRET",
        ],
        dependencies,
      ),
    ).resolves.toBe(0);
    expect(store.rotateEndpointSecret).toHaveBeenCalledWith(
      "merchant-a",
      "ENDPOINT_SECRET",
      now,
    );
  });

  it.each(["0", "257", "1.5", "NaN"])(
    "rejects invalid delivery limit %s",
    async (limit) => {
      const { dependencies, lines } = fixture();
      await expect(
        runCli(["deliver", "--limit", limit], dependencies),
      ).resolves.toBe(2);
      expect(JSON.parse(lines[0]!).error.code).toBe("invalid_configuration");
      expect(dependencies.createTransport).not.toHaveBeenCalled();
    },
  );

  it("runs one delivery batch and closes the transport and store", async () => {
    const { dependencies, lines, store, transport } = fixture();
    await expect(
      runCli(["deliver", "--limit", "32", "--concurrency", "7"], dependencies),
    ).resolves.toBe(0);
    expect(dependencies.deliver).toHaveBeenCalledWith(
      store,
      transport,
      dependencies.env,
      expect.objectContaining({ concurrency: 7, limit: 32, leaseMs: 60_000 }),
    );
    expect(JSON.parse(lines[0]!)).toEqual({
      claimed: 0,
      dead: 0,
      leaseLost: 0,
      retryScheduled: 0,
      succeeded: 0,
    });
    expect(transport.close).toHaveBeenCalledOnce();
    expect(store.close).toHaveBeenCalledOnce();
  });

  it("uses a bounded default delivery concurrency", async () => {
    const { dependencies } = fixture();
    await runCli(["deliver", "--limit", "32"], dependencies);
    expect(dependencies.deliver).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ concurrency: 8 }),
    );
  });

  it.each(["0", "33", "1.5", "NaN"])(
    "rejects invalid delivery concurrency %s",
    async (concurrency) => {
      const { dependencies } = fixture();
      await expect(
        runCli(
          ["deliver", "--limit", "1", "--concurrency", concurrency],
          dependencies,
        ),
      ).resolves.toBe(2);
      expect(dependencies.createTransport).not.toHaveBeenCalled();
    },
  );

  it("replays a delivery and rejects a missing delivery", async () => {
    const { dependencies, lines, store } = fixture();
    const id = "123e4567-e89b-42d3-a456-426614174000";
    await expect(
      runCli(["delivery", "replay", "--id", id], dependencies),
    ).resolves.toBe(0);
    expect(store.replayDelivery).toHaveBeenCalledWith(id, now);
    expect(JSON.parse(lines[0]!)).toEqual({ deliveryId: id, replayed: true });

    store.replayDelivery.mockResolvedValue(false);
    lines.length = 0;
    await expect(
      runCli(["delivery", "replay", "--id", id], dependencies),
    ).resolves.toBe(1);
    expect(JSON.parse(lines[0]!).error.code).toBe("delivery_not_replayable");
  });

  it("inspects event metadata and deliveries without printing payload bytes", async () => {
    const { dependencies, lines, store } = fixture();
    const id = "123e4567-e89b-42d3-a456-426614174000";
    store.inspectEvent.mockResolvedValue({
      id,
      eventType: "invoice.paid",
      sourceType: "invoice",
      sourceId: "invoice-1",
      sourceVersion: 1,
      payload: '{"private":"payload-must-not-print"}',
      digest: "a".repeat(64),
      occurredAt: now,
      createdAt: now,
      deliveries: [],
    });
    await expect(
      runCli(["inspect", "event", "--id", id], dependencies),
    ).resolves.toBe(0);
    expect(JSON.parse(lines[0]!).eventType).toBe("invoice.paid");
    expect(lines[0]).toContain('"payloadDigest"');
    expect(lines[0]).not.toContain("payload-must-not-print");
    expect(lines[0]).not.toContain('"payload"');
  });

  it.each([
    { args: [] },
    { args: ["unknown"] },
    { args: ["migrate", "extra"] },
    { args: ["endpoint", "list", "extra"] },
    {
      args: [
        "endpoint",
        "add",
        "--id",
        "a",
        "--id",
        "b",
        "--url",
        "https://hooks.example.com",
        "--secret-env",
        "ENDPOINT_SECRET",
      ],
    },
    { args: ["deliver", "--limit", "1", "trailing"] },
    {
      args: [
        "deliver",
        "--limit",
        "1",
        "--concurrency",
        "2",
        "--concurrency",
        "3",
      ],
    },
    { args: ["deliver", "--limit", "1", "--workers", "2"] },
  ])(
    "rejects unknown, repeated, or trailing arguments: $args",
    async ({ args }) => {
      const { dependencies } = fixture();
      await expect(runCli(args, dependencies)).resolves.toBe(2);
    },
  );

  it("returns usage status for missing configuration and operational status for failures", async () => {
    const missing = fixture();
    missing.dependencies.env = {};
    await expect(runCli(["migrate"], missing.dependencies)).resolves.toBe(2);

    const failed = fixture();
    vi.mocked(failed.dependencies.migrate).mockRejectedValue(
      new Error("postgres://user:secret@host/database"),
    );
    await expect(runCli(["migrate"], failed.dependencies)).resolves.toBe(1);
    expect(JSON.parse(failed.lines[0]!)).toEqual({
      error: {
        code: "database_unavailable",
        message: "PayOps webhook command failed",
        retryable: true,
      },
    });
  });

  it.each([undefined, ""])(
    "rejects a missing or empty referenced secret",
    async (secret) => {
      const { dependencies, lines } = fixture();
      dependencies.env.ENDPOINT_SECRET = secret;
      await expect(
        runCli(
          [
            "endpoint",
            "add",
            "--id",
            "a",
            "--url",
            "https://hooks.example.com",
            "--secret-env",
            "ENDPOINT_SECRET",
          ],
          dependencies,
        ),
      ).resolves.toBe(2);
      expect(lines[0]).not.toContain("do-not-print");
      expect(JSON.parse(lines[0]!).error.code).toBe("invalid_configuration");
    },
  );

  it("closes opened resources when delivery fails", async () => {
    const { dependencies, store, transport } = fixture();
    vi.mocked(dependencies.deliver).mockRejectedValue(new Error("boom"));
    await expect(
      runCli(["deliver", "--limit", "1"], dependencies),
    ).resolves.toBe(1);
    expect(transport.close).toHaveBeenCalledOnce();
    expect(store.close).toHaveBeenCalledOnce();
  });
});
