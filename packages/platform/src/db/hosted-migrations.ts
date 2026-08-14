import { runMigrations as runIngestionMigrations } from "@payops/ingestion";
import { runMigrations as runReconciliationMigrations } from "@payops/reconciliation";
import { runMigrations as runWebhookMigrations } from "@payops/webhooks";
import { runPlatformMigrations } from "./migrate.js";

export type HostedMigrationName =
  "ingestion" | "webhooks" | "reconciliation" | "platform";

export interface HostedMigrationResult {
  readonly status: "ok";
  readonly migrationSets: readonly HostedMigrationName[];
}

export interface HostedMigrationRunners {
  readonly ingestion: (databaseUrl: string) => Promise<void>;
  readonly webhooks: (databaseUrl: string) => Promise<void>;
  readonly reconciliation: (databaseUrl: string) => Promise<void>;
  readonly platform: (databaseUrl: string) => Promise<void>;
}

const hostedMigrationNames = Object.freeze([
  "ingestion",
  "webhooks",
  "reconciliation",
  "platform",
] satisfies readonly HostedMigrationName[]);

const defaultRunners: HostedMigrationRunners = Object.freeze({
  ingestion: runIngestionMigrations,
  webhooks: runWebhookMigrations,
  reconciliation: runReconciliationMigrations,
  platform: runPlatformMigrations,
});

class HostedMigrationError extends Error {
  readonly code = "hosted_migration_failed";
  readonly migrationSet: HostedMigrationName;

  constructor(migrationSet: HostedMigrationName) {
    super("Hosted migration failed");
    this.name = "HostedMigrationError";
    this.migrationSet = migrationSet;
  }
}

export async function runHostedMigrationSequence(
  databaseUrl: string,
  runners: HostedMigrationRunners,
): Promise<HostedMigrationResult> {
  for (const name of hostedMigrationNames) {
    try {
      await runners[name](databaseUrl);
    } catch {
      throw new HostedMigrationError(name);
    }
  }
  return Object.freeze({
    status: "ok" as const,
    migrationSets: hostedMigrationNames,
  });
}

export async function runHostedMigrations(
  databaseUrl: string,
): Promise<HostedMigrationResult> {
  return runHostedMigrationSequence(databaseUrl, defaultRunners);
}
