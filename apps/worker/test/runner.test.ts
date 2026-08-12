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
  "reconcile_attempts",
  "project_payment_status",
  "expire_quotes",
  "send_webhooks",
];

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
      expect.objectContaining({ errorCode: "rpc_transport_error" }),
    );
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
    expect(store.completed).toHaveLength(1);
  });

  it("releases a lease claimed during shutdown before handler work", async () => {
    const controller = new AbortController();
    const store = new FakeStore(() => controller.abort());
    const handler = vi.fn(async () => ({ processed: 1 }));
    await runWorker({
      store,
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
      jobs: [job("send_webhooks")],
      handlers: { send_webhooks: handler },
      signal: controller.signal,
      sleep: async () => {
        await new Promise<void>((resolve) => setImmediate(resolve));
        controller.abort();
      },
    });
    expect(handler).toHaveBeenCalledOnce();
    expect(store.completed).toHaveLength(1);
  });

  it("rejects a shutdown grace period above the production ceiling", async () => {
    await expect(
      runWorker({
        store: new FakeStore(),
        jobs: [job("send_webhooks")],
        handlers: { send_webhooks: async () => ({}) },
        signal: new AbortController().signal,
        shutdownGraceMs: 30_001,
      }),
    ).rejects.toThrow("shutdown grace period");
  });
});

class FakeStore {
  readonly completed: {
    lease: WorkerJobLease;
    cursor?: WorkerJobCursor;
    errorCode?: string;
  }[] = [];
  readonly released: WorkerJobLease[] = [];
  readonly #onClaim: (() => void) | undefined;

  public constructor(onClaim?: () => void) {
    this.#onClaim = onClaim;
  }

  public async claim(input: {
    name: WorkerJobName;
    now: Date;
    leaseMs: number;
  }): Promise<WorkerJobLease> {
    const lease = {
      name: input.name,
      token: `${input.name}-lease`,
      expiresAt: new Date(input.now.getTime() + input.leaseMs),
      cursor: {},
    };
    this.#onClaim?.();
    return lease;
  }

  public async complete(input: {
    lease: WorkerJobLease;
    now: Date;
    cursor?: WorkerJobCursor;
    errorCode?: string;
  }): Promise<boolean> {
    this.completed.push(input);
    return true;
  }

  public async renew(input: {
    lease: WorkerJobLease;
    now: Date;
    leaseMs: number;
  }): Promise<WorkerJobLease> {
    return {
      ...input.lease,
      expiresAt: new Date(input.now.getTime() + input.leaseMs),
    };
  }

  public async release(lease: WorkerJobLease): Promise<boolean> {
    this.released.push(lease);
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
