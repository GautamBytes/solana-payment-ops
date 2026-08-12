#!/usr/bin/env node
import { WorkerJobStore } from "@payops/platform";
import { parseWorkerConfig } from "./config.js";
import { HostedWorkerJobs } from "./jobs.js";
import { runWorker } from "./runner.js";

void main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${safeCode(error)}\n`);
    process.exitCode = 1;
  },
);

async function main(): Promise<number> {
  const config = parseWorkerConfig(process.env);
  const store = new WorkerJobStore(config.databaseUrl);
  const jobs = new HostedWorkerJobs({
    databaseUrl: config.databaseUrl,
    environment: process.env,
    parserVersion: config.parserVersion,
  });
  const controller = new AbortController();
  const stop = () => controller.abort(new Error("Worker shutdown requested"));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await store.assertReady();
    await jobs.assertReady();
    await runWorker({
      store,
      jobs: config.jobs,
      handlers: jobs.handlers(),
      signal: controller.signal,
    });
    return 0;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await Promise.allSettled([jobs.close(), store.close()]);
  }
}

function safeCode(error: unknown): string {
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
        /^[a-z][a-z0-9_]{0,127}$/.test(descriptor.value)
      ) {
        return descriptor.value;
      }
    } catch {
      return "worker_failed";
    }
  }
  return "worker_failed";
}
