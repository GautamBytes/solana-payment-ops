import type {
  WorkerJobCursor,
  WorkerJobLease,
  WorkerJobName,
} from "@payops/platform";
import { describe, expect, it, vi } from "vitest";
import type { WorkerJobConfig } from "../src/config.js";
import { runWorker, type WorkerJobHandler } from "../src/runner.js";

const names: readonly WorkerJobName[] = [
  "ingest_watch_targets",
  "refresh_finality",
  "verify_rpc_consensus",
  "project_payment_status",
  "expire_quotes",
  "send_webhooks",
];
const testRpc = {
  mode: "single_provider" as const,
  cluster: "localnet" as const,
  primaryProviderId: "test-provider",
  primaryEndpointEnvironment: "TEST_RPC_URL",
  primaryEndpointDigest: "a".repeat(64),
  secondaryProviderId: null,
  secondaryEndpointEnvironment: null,
  secondaryEndpointDigest: null,
};

describe("worker runner", () => {
  it("runs every due job and isolates one handler failure", async () => {
    const controller = new AbortController();
    const store = new FakeStore();
    const calls: WorkerJobName[] = [];
    const handlers = Object.fromEntries(
      names.map((name) => [
        name,
        async () => {
          calls.push(name);
          if (name === "refresh_finality") {
            throw Object.assign(new Error("provider down"), {
              code: "rpc_transport_error",
            });
          }
          return { processed: 1 };
        },
      ]),
    ) as unknown as Record<WorkerJobName, WorkerJobHandler>;
    await runWorker({
      store,
      buildRevision: "test-build",
      rpc: testRpc,
      jobs: names.map(job),
      handlers,
      signal: controller.signal,
      sleep: async () => {
        await new Promise<void>((resolve) => setImmediate(resolve));
        controller.abort();
      },
    });
    expect(calls.sort()).toEqual([...names].sort());
    expect(store.completed).toHaveLength(6);
    expect(store.completed).toContainEqual(
      expect.objectContaining({ failureClass: "dependency" }),
    );
    expect(store.lifecycle).toEqual(["started", "draining", "stopped"]);
  });

  it("does not overlap a slow instance and settles it before returning", async () => {
    const controller = new AbortController();
    const store = new FakeStore();
    let now = 0;
    let release!: () => void;
    const handler = vi.fn(
      () =>
        new Promise<WorkerJobCursor>((resolve) => {
          release = () => resolve({ processed: 1 });
        }),
    );
    let sleeps = 0;
    await runWorker({
      store,
      buildRevision: "test-build",
      rpc: testRpc,
      jobs: [job("expire_quotes")],
      handlers: { expire_quotes: handler },
      signal: controller.signal,
      now: () => new Date(now),
      sleep: async () => {
        sleeps += 1;
        now += 10_000;
        if (sleeps === 2) {
          release();
          controller.abort();
        }
      },
    });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(store.completed).toHaveLength(0);
    expect(store.released).toHaveLength(1);
  });

  it("releases a lease claimed during shutdown before handler work", async () => {
    const controller = new AbortController();
    const store = new FakeStore(() => controller.abort());
    const handler = vi.fn(async () => ({ processed: 1 }));
    await runWorker({
      store,
      buildRevision: "test-build",
      rpc: testRpc,
      jobs: [job("send_webhooks")],
      handlers: { send_webhooks: handler },
      signal: controller.signal,
    });
    expect(handler).not.toHaveBeenCalled();
    expect(store.released).toHaveLength(1);
  });

  it("fails shutdown when an aborted handler does not settle", async () => {
    const controller = new AbortController();
    const store = new FakeStore();
    let handlerSignal: AbortSignal | undefined;
    const handler = vi.fn(({ signal }: { signal: AbortSignal }) => {
      handlerSignal = signal;
      return new Promise<WorkerJobCursor>(() => undefined);
    });
    const startedAt = Date.now();
    await expect(
      runWorker({
        store,
        buildRevision: "test-build",
        rpc: testRpc,
        jobs: [job("send_webhooks")],
        handlers: { send_webhooks: handler },
        signal: controller.signal,
        shutdownGraceMs: 10,
        sleep: async () => {
          await new Promise<void>((resolve) => setImmediate(resolve));
          controller.abort();
        },
      }),
    ).rejects.toMatchObject({ code: "incomplete_worker_shutdown" });
    expect(handler).toHaveBeenCalledOnce();
    expect(handlerSignal?.aborted).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("completes cleanly when an active handler honors shutdown", async () => {
    const controller = new AbortController();
    const store = new FakeStore();
    const handler = vi.fn(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise<WorkerJobCursor>((resolve) => {
          signal.addEventListener("abort", () => resolve({ processed: 0 }), {
            once: true,
          });
        }),
    );
    await runWorker({
      store,
      buildRevision: "test-build",
      rpc: testRpc,
      jobs: [job("send_webhooks")],
      handlers: { send_webhooks: handler },
      signal: controller.signal,
      sleep: async () => {
        await new Promise<void>((resolve) => setImmediate(resolve));
        controller.abort();
      },
    });
    expect(handler).toHaveBeenCalledOnce();
    expect(store.completed).toHaveLength(0);
    expect(store.released).toHaveLength(1);
    expect(store.lifecycle).toEqual(["started", "draining", "stopped"]);
  });

  it("rejects a shutdown grace period above the production ceiling", async () => {
    await expect(
      runWorker({
        store: new FakeStore(),
        buildRevision: "test-build",
        rpc: testRpc,
        jobs: [job("send_webhooks")],
        handlers: { send_webhooks: async () => ({}) },
        signal: new AbortController().signal,
        shutdownGraceMs: 30_001,
      }),
    ).rejects.toThrow("shutdown grace period");
  });

  it("treats stale completion as failure backoff instead of success", async () => {
    const controller = new AbortController();
    const store = new FakeStore(undefined, { completeResult: false });
    let now = 0;
    let sleeps = 0;
    await runWorker({
      store,
      buildRevision: "test-build",
      rpc: testRpc,
      jobs: [job("project_payment_status")],
      handlers: { project_payment_status: async () => ({ changed: 1 }) },
      signal: controller.signal,
      now: () => new Date(now),
      random: () => 0,
      sleep: async () => {
        await new Promise<void>((resolve) => setImmediate(resolve));
        sleeps += 1;
        now += 300;
        if (sleeps === 2) controller.abort();
      },
    });
    expect(store.claims).toBe(1);
    expect(store.successfulCompletions).toBe(0);
  });

  it("does not mark a handler successful after lease loss", async () => {
    const controller = new AbortController();
    const store = new FakeStore(undefined, { loseLease: true });
    const handler = vi.fn(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise<WorkerJobCursor>((resolve) => {
          signal.addEventListener("abort", () => resolve({ processed: 1 }), {
            once: true,
          });
        }),
    );
    await runWorker({
      store,
      buildRevision: "test-build",
      rpc: testRpc,
      jobs: [job("verify_rpc_consensus")],
      handlers: { verify_rpc_consensus: handler },
      signal: controller.signal,
      leaseSleep: async () => undefined,
      sleep: async () => {
        await new Promise<void>((resolve) => setImmediate(resolve));
        controller.abort();
      },
    });
    expect(store.successfulCompletions).toBe(0);
    expect(store.released).toHaveLength(1);
  });

  it("aborts the handler and awaits lease cleanup when renewal throws", async () => {
    const controller = new AbortController();
    let cleanupFinished = false;
    let handlerWasAborted = false;
    const store = new FakeStore(undefined, {
      renewError: Object.assign(new Error("database unavailable"), {
        code: "database_unavailable",
      }),
      onRelease: async () => {
        await new Promise<void>((resolve) => setImmediate(resolve));
        cleanupFinished = true;
      },
    });
    const handler = vi.fn(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise<WorkerJobCursor>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              handlerWasAborted = true;
              resolve({ processed: 0 });
            },
            { once: true },
          );
        }),
    );
    await runWorker({
      store,
      buildRevision: "test-build",
      rpc: testRpc,
      jobs: [job("verify_rpc_consensus")],
      handlers: { verify_rpc_consensus: handler },
      signal: controller.signal,
      leaseSleep: async () => undefined,
      sleep: async () => {
        while (!cleanupFinished) {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        controller.abort();
      },
    });
    expect(handlerWasAborted).toBe(true);
    expect(store.completed).toHaveLength(0);
    expect(store.released).toHaveLength(1);
    expect(cleanupFinished).toBe(true);
  });
});

class FakeStore {
  readonly completed: {
    lease: WorkerJobLease;
    cursor?: WorkerJobCursor;
    failureClass?: string;
  }[] = [];
  readonly released: WorkerJobLease[] = [];
  readonly lifecycle: string[] = [];
  claims = 0;
  successfulCompletions = 0;
  readonly #onClaim: (() => void) | undefined;
  readonly #completeResult: boolean;
  readonly #loseLease: boolean;
  readonly #renewError: unknown;
  readonly #onRelease: (() => Promise<void>) | undefined;
  readonly #instanceId = "00000000-0000-4000-8000-000000000001";

  public constructor(
    onClaim?: () => void,
    options: {
      completeResult?: boolean;
      loseLease?: boolean;
      renewError?: unknown;
      onRelease?: () => Promise<void>;
    } = {},
  ) {
    this.#onClaim = onClaim;
    this.#completeResult = options.completeResult ?? true;
    this.#loseLease = options.loseLease ?? false;
    this.#renewError = options.renewError;
    this.#onRelease = options.onRelease;
  }

  public async startInstance(): Promise<{
    id: string;
    state: "running";
    startedAt: Date;
    lastHeartbeatAt: Date;
    rpc: typeof testRpc;
  }> {
    this.lifecycle.push("started");
    return {
      id: this.#instanceId,
      state: "running",
      startedAt: new Date(0),
      lastHeartbeatAt: new Date(0),
      rpc: testRpc,
    };
  }

  public async heartbeat(): Promise<boolean> {
    return true;
  }

  public async drainInstance(): Promise<boolean> {
    this.lifecycle.push("draining");
    return true;
  }

  public async stopInstance(): Promise<boolean> {
    this.lifecycle.push("stopped");
    return true;
  }

  public async claim(input: {
    name: WorkerJobName;
    instanceId: string;
    now: Date;
    intervalMs: number;
    leaseMs: number;
  }): Promise<WorkerJobLease> {
    const lease = {
      name: input.name,
      token: `${input.name}-lease`,
      instanceId: input.instanceId,
      expiresAt: new Date(input.now.getTime() + input.leaseMs),
      cursor: {},
    };
    this.#onClaim?.();
    this.claims += 1;
    return lease;
  }

  public async complete(input: {
    lease: WorkerJobLease;
    now: Date;
    cursor?: WorkerJobCursor;
    failureClass?: string;
  }): Promise<boolean> {
    this.completed.push(input);
    if (this.#completeResult) this.successfulCompletions += 1;
    return this.#completeResult;
  }

  public async renew(input: {
    lease: WorkerJobLease;
    now: Date;
    leaseMs: number;
  }): Promise<WorkerJobLease | null> {
    if (this.#renewError !== undefined) throw this.#renewError;
    if (this.#loseLease) return null;
    return {
      ...input.lease,
      expiresAt: new Date(input.now.getTime() + input.leaseMs),
    };
  }

  public async release(lease: WorkerJobLease): Promise<boolean> {
    this.released.push(lease);
    await this.#onRelease?.();
    return true;
  }
}

function job(name: WorkerJobName): WorkerJobConfig {
  return {
    name,
    intervalMs: 250,
    batchSize: 10,
    concurrency: 2,
    leaseMs: 5_000,
  };
}
