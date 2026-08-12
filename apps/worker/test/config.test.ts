import { describe, expect, it } from "vitest";
import { parseWorkerConfig } from "../src/config.js";

describe("worker configuration", () => {
  it("uses bounded defaults for every required job", () => {
    const config = parseWorkerConfig({
      DATABASE_URL: "postgresql://worker:secret@db.example/payops",
    });
    expect(config.jobs).toHaveLength(6);
    expect(config.jobs[0]).toMatchObject({
      intervalMs: 2_000,
      batchSize: 50,
      concurrency: 4,
      leaseMs: 30_000,
    });
    expect(config.parserVersion).toBe("0.2.0");
  });

  it.each([
    ["PAYOPS_WORKER_INTERVAL_MS", "249"],
    ["PAYOPS_WORKER_INTERVAL_MS", "60001"],
    ["PAYOPS_WORKER_BATCH_SIZE", "0"],
    ["PAYOPS_WORKER_BATCH_SIZE", "101"],
    ["PAYOPS_WORKER_CONCURRENCY", "17"],
    ["PAYOPS_WORKER_LEASE_MS", "4999"],
    ["PAYOPS_WORKER_LEASE_MS", "120001"],
    ["PAYOPS_WORKER_BATCH_SIZE", "01"],
  ])("rejects %s=%s", (name, value) => {
    expect(() =>
      parseWorkerConfig({
        DATABASE_URL: "postgresql://worker:secret@db.example/payops",
        [name]: value,
      }),
    ).toThrow("configuration");
  });

  it("does not accept inherited configuration", () => {
    const environment = Object.create({
      DATABASE_URL: "postgresql://evil",
    }) as NodeJS.ProcessEnv;
    expect(() => parseWorkerConfig(environment)).toThrow(
      "configuration is invalid",
    );
  });
});
