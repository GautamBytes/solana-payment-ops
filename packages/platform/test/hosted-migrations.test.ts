import { describe, expect, test } from "vitest";
import {
  runHostedMigrationSequence,
  type HostedMigrationRunners,
} from "../src/db/hosted-migrations.js";

const databaseUrl = "postgresql://migrator:do-not-disclose@db.example/payops";

describe("hosted migration orchestration", () => {
  test("runs every migration set sequentially in the exact hosted order", async () => {
    const calls: string[] = [];
    let active = 0;
    const runner = (name: string) => async (receivedUrl: string) => {
      expect(receivedUrl).toBe(databaseUrl);
      expect(active).toBe(0);
      active += 1;
      await Promise.resolve();
      calls.push(name);
      active -= 1;
    };
    const runners: HostedMigrationRunners = {
      ingestion: runner("ingestion"),
      webhooks: runner("webhooks"),
      reconciliation: runner("reconciliation"),
      platform: runner("platform"),
    };

    const result = await runHostedMigrationSequence(databaseUrl, runners);

    expect(calls).toEqual([
      "ingestion",
      "webhooks",
      "reconciliation",
      "platform",
    ]);
    expect(result).toEqual({
      status: "ok",
      migrationSets: ["ingestion", "webhooks", "reconciliation", "platform"],
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.migrationSets)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(databaseUrl);
  });

  test("stops immediately and returns no credential-bearing failure", async () => {
    const calls: string[] = [];
    const runners: HostedMigrationRunners = {
      ingestion: async () => void calls.push("ingestion"),
      webhooks: async () => {
        calls.push("webhooks");
        throw new Error(`connection failed for ${databaseUrl}`);
      },
      reconciliation: async () => void calls.push("reconciliation"),
      platform: async () => void calls.push("platform"),
    };

    let failure: unknown;
    try {
      await runHostedMigrationSequence(databaseUrl, runners);
    } catch (error) {
      failure = error;
    }

    expect(calls).toEqual(["ingestion", "webhooks"]);
    expect(failure).toMatchObject({
      code: "hosted_migration_failed",
      migrationSet: "webhooks",
    });
    expect(String(failure)).not.toContain(databaseUrl);
    expect(JSON.stringify(failure)).not.toContain(databaseUrl);
  });
});
