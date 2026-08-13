import type {
  WorkerJobLease,
  WorkerJobCursor,
  WorkerJobName,
  WorkerJobStore,
  WorkerFailureClass,
  RpcProviderConfigurationIdentity,
} from "@payops/platform";
import type { WorkerJobConfig } from "./config.js";

export interface WorkerJobContext {
  readonly instanceId: string;
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
    | "claim"
    | "complete"
    | "release"
    | "renew"
    | "startInstance"
    | "heartbeat"
    | "drainInstance"
    | "stopInstance"
  >;
  readonly buildRevision: string;
  readonly rpc: RpcProviderConfigurationIdentity;
  readonly jobs: readonly WorkerJobConfig[];
  readonly handlers: Readonly<Partial<Record<WorkerJobName, WorkerJobHandler>>>;
  readonly signal: AbortSignal;
  readonly now?: () => Date;
  readonly random?: () => number;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly heartbeatSleep?: (
    milliseconds: number,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly leaseSleep?: (
    milliseconds: number,
    signal: AbortSignal,
  ) => Promise<void>;
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
  const instance = await input.store.startInstance({
    buildRevision: input.buildRevision,
    rpc: input.rpc,
  });
  const runtimeController = new AbortController();
  const stopRuntime = () => runtimeController.abort(input.signal.reason);
  input.signal.addEventListener("abort", stopRuntime, { once: true });
  if (input.signal.aborted) stopRuntime();
  let heartbeatFailure: unknown;
  const heartbeat = maintainHeartbeat(
    input.store,
    instance.id,
    runtimeController,
    input.heartbeatSleep ?? abortableSleep,
    (error) => {
      heartbeatFailure = error;
      runtimeController.abort(error);
    },
  );
  const nextRun = new Map(input.jobs.map((job) => [job.name, 0]));
  const failures = new Map<WorkerJobName, number>();
  const active = new Map<WorkerJobName, Promise<void>>();

  let settled = false;
  try {
    while (!runtimeController.signal.aborted) {
      const now = clock();
      for (const job of input.jobs) {
        if (
          !active.has(job.name) &&
          now.getTime() >= (nextRun.get(job.name) ?? 0)
        ) {
          const execution = runOne(
            input,
            job,
            now,
            instance.id,
            runtimeController.signal,
          )
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
      if (runtimeController.signal.aborted) break;
      const wakeAt = Math.min(
        ...input.jobs.map((job) => nextRun.get(job.name) ?? now.getTime()),
      );
      try {
        await sleep(
          Math.max(1, Math.min(250, wakeAt - now.getTime())),
          runtimeController.signal,
        );
      } catch {
        if (!runtimeController.signal.aborted) {
          throw new Error("Worker timer failed");
        }
      }
    }
    await input.store.drainInstance(instance.id);
    await settleActive(active.values(), shutdownGraceMs);
    settled = true;
    if (heartbeatFailure !== undefined) throw heartbeatFailure;
  } finally {
    runtimeController.abort();
    await heartbeat;
    input.signal.removeEventListener("abort", stopRuntime);
    if (settled) await input.store.stopInstance(instance.id);
  }
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
  instanceId: string,
  signal: AbortSignal,
): Promise<boolean> {
  let lease: WorkerJobLease | null = null;
  try {
    lease = await input.store.claim({
      instanceId,
      name: job.name,
      now,
      intervalMs: job.intervalMs,
      leaseMs: job.leaseMs,
    });
    if (lease === null) return true;
    if (signal.aborted) {
      await input.store.release(lease, now);
      return true;
    }
    const handler = input.handlers[job.name];
    if (handler === undefined) throw new TypeError("Worker handler is missing");
    const leaseController = new AbortController();
    const stopHeartbeat = () => leaseController.abort(signal.reason);
    signal.addEventListener("abort", stopHeartbeat, { once: true });
    if (signal.aborted) stopHeartbeat();
    const heartbeat = renewLease(
      input.store,
      lease,
      job.leaseMs,
      leaseController,
      input.leaseSleep ?? abortableSleep,
    );
    try {
      const cursor = await handler({
        instanceId,
        signal: AbortSignal.any([signal, leaseController.signal]),
        now,
        batchSize: job.batchSize,
        concurrency: job.concurrency,
        cursor: lease.cursor,
      });
      if (signal.aborted || leaseController.signal.aborted) {
        await input.store.release(lease, new Date());
        return false;
      }
      return await input.store.complete({ lease, now: new Date(), cursor });
    } finally {
      signal.removeEventListener("abort", stopHeartbeat);
      leaseController.abort();
      await heartbeat;
    }
  } catch (error) {
    if (lease !== null) {
      if (signal.aborted || safeErrorCode(error) === "worker_lease_lost") {
        await input.store.release(lease, new Date()).catch(() => false);
      } else {
        await input.store
          .complete({
            lease,
            now: new Date(),
            failureClass: classifyFailure(error),
          })
          .catch(() => false);
      }
    }
    return false;
  }
}

async function renewLease(
  store: Pick<WorkerJobStore, "renew">,
  lease: WorkerJobLease,
  leaseMs: number,
  controller: AbortController,
  sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>,
): Promise<void> {
  while (!controller.signal.aborted) {
    try {
      await sleep(Math.max(1_000, Math.floor(leaseMs / 3)), controller.signal);
    } catch {
      return;
    }
    let renewed: WorkerJobLease | null;
    try {
      renewed = await store.renew({ lease, now: new Date(), leaseMs });
    } catch (error) {
      controller.abort(error);
      return;
    }
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

async function maintainHeartbeat(
  store: Pick<WorkerJobStore, "heartbeat">,
  instanceId: string,
  controller: AbortController,
  sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>,
  fail: (error: unknown) => void,
): Promise<void> {
  while (!controller.signal.aborted) {
    try {
      await sleep(10_000, controller.signal);
    } catch {
      return;
    }
    try {
      if (!(await store.heartbeat(instanceId))) {
        throw Object.assign(new Error("Worker heartbeat was rejected"), {
          code: "worker_heartbeat_lost",
        });
      }
    } catch (error) {
      fail(error);
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

export function classifyFailure(error: unknown): WorkerFailureClass {
  const code = safeErrorCode(error);
  if (
    code === "missing_configuration" ||
    code === "invalid_configuration" ||
    code === "invalid_rpc_configuration"
  ) {
    return "configuration";
  }
  if (
    code.startsWith("rpc_") ||
    code.startsWith("database_") ||
    code.startsWith("webhook_")
  ) {
    return "dependency";
  }
  if (
    code === "worker_busy" ||
    code === "worker_lease_lost" ||
    code === "worker_aborted"
  ) {
    return "contention";
  }
  if (error instanceof TypeError || code.includes("invariant")) {
    return "invariant";
  }
  return "unknown";
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
