import type {
  WorkerJobLease,
  WorkerJobCursor,
  WorkerJobName,
  WorkerJobStore,
} from "@payops/platform";
import type { WorkerJobConfig } from "./config.js";

export interface WorkerJobContext {
  readonly signal: AbortSignal;
  readonly now: Date;
  readonly batchSize: number;
  readonly concurrency: number;
  readonly cursor: WorkerJobCursor;
}

export type WorkerJobHandler = (
  context: WorkerJobContext,
) => Promise<WorkerJobCursor>;

export interface WorkerRunDependencies {
  readonly store: Pick<
    WorkerJobStore,
    "claim" | "complete" | "release" | "renew"
  >;
  readonly jobs: readonly WorkerJobConfig[];
  readonly handlers: Readonly<Partial<Record<WorkerJobName, WorkerJobHandler>>>;
  readonly signal: AbortSignal;
  readonly now?: () => Date;
  readonly random?: () => number;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly shutdownGraceMs?: number;
}

export async function runWorker(input: WorkerRunDependencies): Promise<void> {
  validateJobs(input.jobs);
  const clock = input.now ?? (() => new Date());
  const random = input.random ?? Math.random;
  const sleep = input.sleep ?? abortableSleep;
  const shutdownGraceMs = input.shutdownGraceMs ?? 30_000;
  if (
    !Number.isInteger(shutdownGraceMs) ||
    shutdownGraceMs < 1 ||
    shutdownGraceMs > 30_000
  ) {
    throw new TypeError("Worker shutdown grace period is invalid");
  }
  const nextRun = new Map(input.jobs.map((job) => [job.name, 0]));
  const failures = new Map<WorkerJobName, number>();
  const active = new Map<WorkerJobName, Promise<void>>();

  while (!input.signal.aborted) {
    const now = clock();
    for (const job of input.jobs) {
      if (
        !active.has(job.name) &&
        now.getTime() >= (nextRun.get(job.name) ?? 0)
      ) {
        const execution = runOne(input, job, now)
          .then((succeeded) => {
            const failureCount = succeeded
              ? 0
              : Math.min((failures.get(job.name) ?? 0) + 1, 8);
            failures.set(job.name, failureCount);
            const multiplier = succeeded ? 1 : 2 ** failureCount;
            const jitter = succeeded
              ? 0
              : Math.floor(random() * job.intervalMs);
            nextRun.set(
              job.name,
              clock().getTime() +
                Math.min(60_000, job.intervalMs * multiplier + jitter),
            );
          })
          .finally(() => active.delete(job.name));
        active.set(job.name, execution);
      }
    }
    if (input.signal.aborted) break;
    const wakeAt = Math.min(
      ...input.jobs.map((job) => nextRun.get(job.name) ?? now.getTime()),
    );
    try {
      await sleep(
        Math.max(1, Math.min(250, wakeAt - now.getTime())),
        input.signal,
      );
    } catch {
      if (!input.signal.aborted) throw new Error("Worker timer failed");
    }
  }
  await settleActive(active.values(), shutdownGraceMs);
}

async function settleActive(
  executions: Iterable<Promise<void>>,
  shutdownGraceMs: number,
): Promise<void> {
  const settled = Promise.allSettled(executions).then(() => true);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<false>((resolve) => {
    timeout = setTimeout(() => resolve(false), shutdownGraceMs);
    timeout.unref();
  });
  const completed = await Promise.race([settled, deadline]);
  if (timeout !== undefined) clearTimeout(timeout);
  if (!completed) {
    throw Object.assign(
      new Error("Worker did not stop within the shutdown grace period"),
      { code: "incomplete_worker_shutdown" },
    );
  }
}

async function runOne(
  input: WorkerRunDependencies,
  job: WorkerJobConfig,
  now: Date,
): Promise<boolean> {
  let lease: WorkerJobLease | null = null;
  try {
    lease = await input.store.claim({
      name: job.name,
      now,
      leaseMs: job.leaseMs,
    });
    if (lease === null) return true;
    if (input.signal.aborted) {
      await input.store.release(lease, now);
      return true;
    }
    const handler = input.handlers[job.name];
    if (handler === undefined) throw new TypeError("Worker handler is missing");
    const leaseController = new AbortController();
    const stopHeartbeat = () => leaseController.abort(input.signal.reason);
    input.signal.addEventListener("abort", stopHeartbeat, { once: true });
    if (input.signal.aborted) stopHeartbeat();
    const heartbeat = renewLease(
      input.store,
      lease,
      job.leaseMs,
      leaseController,
    );
    try {
      const cursor = await handler({
        signal: AbortSignal.any([input.signal, leaseController.signal]),
        now,
        batchSize: job.batchSize,
        concurrency: job.concurrency,
        cursor: lease.cursor,
      });
      return input.store.complete({ lease, now: new Date(), cursor });
    } finally {
      input.signal.removeEventListener("abort", stopHeartbeat);
      leaseController.abort();
      await heartbeat;
    }
  } catch (error) {
    if (lease !== null) {
      await input.store
        .complete({ lease, now: new Date(), errorCode: safeErrorCode(error) })
        .catch(() => false);
    }
    return false;
  }
}

async function renewLease(
  store: Pick<WorkerJobStore, "renew">,
  lease: WorkerJobLease,
  leaseMs: number,
  controller: AbortController,
): Promise<void> {
  while (!controller.signal.aborted) {
    try {
      await abortableSleep(
        Math.max(1_000, Math.floor(leaseMs / 3)),
        controller.signal,
      );
    } catch {
      return;
    }
    const renewed = await store.renew({ lease, now: new Date(), leaseMs });
    if (renewed === null) {
      controller.abort(
        Object.assign(new Error("Worker lease was lost"), {
          code: "worker_lease_lost",
        }),
      );
      return;
    }
  }
}

function validateJobs(jobs: readonly WorkerJobConfig[]): void {
  if (
    jobs.length === 0 ||
    new Set(jobs.map(({ name }) => name)).size !== jobs.length
  ) {
    throw new TypeError("Worker jobs must be unique");
  }
  for (const job of jobs) {
    if (
      !Number.isInteger(job.intervalMs) ||
      job.intervalMs < 250 ||
      job.intervalMs > 60_000 ||
      !Number.isInteger(job.batchSize) ||
      job.batchSize < 1 ||
      job.batchSize > 100 ||
      !Number.isInteger(job.concurrency) ||
      job.concurrency < 1 ||
      job.concurrency > 16 ||
      !Number.isInteger(job.leaseMs) ||
      job.leaseMs < 5_000 ||
      job.leaseMs > 120_000
    ) {
      throw new TypeError("Worker job bounds are invalid");
    }
  }
}

function safeErrorCode(error: unknown): string {
  if (
    error !== null &&
    (typeof error === "object" || typeof error === "function")
  ) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(error, "code");
      if (
        descriptor !== undefined &&
        "value" in descriptor &&
        typeof descriptor.value === "string" &&
        /^[a-z][a-z0-9_]{0,63}$/.test(descriptor.value)
      ) {
        return descriptor.value;
      }
    } catch {
      return "job_failed";
    }
  }
  return "job_failed";
}

function abortableSleep(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timeout = setTimeout(resolve, milliseconds);
    timeout.unref();
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
