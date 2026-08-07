#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stringifyCanonical } from "@payops/core";
import { parseInvoiceCsv } from "./import/invoice-csv.js";
import { ReconciliationError } from "./domain/types.js";
import { runReconciliation } from "./reconciliation-service.js";
import { renderCsvReport } from "./report/csv-report.js";
import { runMigrations } from "./storage/migrate.js";
import { PostgresReconciliationStore } from "./storage/postgres-reconciliation-store.js";
import type { OperatorReconciliationStore } from "./storage/types.js";

export interface CliDependencies {
  readonly env: NodeJS.ProcessEnv;
  readonly write: (line: string) => void;
  readonly readFile: (path: string, encoding: "utf8") => Promise<string>;
  readonly migrate: (databaseUrl: string) => Promise<void>;
  readonly now: () => Date;
  readonly createStore: (databaseUrl: string) => OperatorReconciliationStore;
}

const defaults: CliDependencies = {
  env: process.env,
  write: (line) => process.stdout.write(`${line}\n`),
  readFile,
  migrate: runMigrations,
  now: () => new Date(),
  createStore: (databaseUrl) =>
    new PostgresReconciliationStore({ databaseUrl }),
};

function configuration(message: string): never {
  throw new ReconciliationError("invalid_configuration", message, {
    retryable: false,
  });
}

function flag(args: readonly string[], name: string): string {
  const index = args.indexOf(`--${name}`);
  const value = index < 0 ? undefined : args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    configuration(`Missing required --${name} option`);
  }
  return value;
}

function json(write: CliDependencies["write"], value: unknown): void {
  write(stringifyCanonical(value).trimEnd());
}

export async function runCli(
  argv: readonly string[],
  dependencies: CliDependencies = defaults,
): Promise<number> {
  try {
    const databaseUrl = dependencies.env.DATABASE_URL;
    if (databaseUrl === undefined || databaseUrl.length === 0) {
      configuration("DATABASE_URL is not set");
    }
    const [command, subcommand, ...rest] = argv;
    if (command === "migrate" && subcommand === undefined) {
      await dependencies.migrate(databaseUrl);
      json(dependencies.write, { migrated: true });
      return 0;
    }
    const store = dependencies.createStore(databaseUrl);
    try {
      if (command === "invoice" && subcommand === "import") {
        if (rest.length !== 2)
          configuration("Invoice import requires --file path");
        const invoices = parseInvoiceCsv(
          await dependencies.readFile(flag(rest, "file"), "utf8"),
        );
        json(
          dependencies.write,
          await store.importInvoices(invoices, dependencies.now()),
        );
        return 0;
      }
      if (
        command === "reconcile" &&
        subcommand === "run" &&
        rest.length === 0
      ) {
        json(
          dependencies.write,
          await runReconciliation(store, dependencies.now()),
        );
        return 0;
      }
      if (
        command === "report" &&
        subcommand === "--format" &&
        rest.length === 1
      ) {
        const format = rest[0];
        if (format === "csv") {
          const rows = await store.getReportRows();
          dependencies.write(renderCsvReport(rows).trimEnd());
        } else if (format === "json") {
          json(dependencies.write, await store.getReport(dependencies.now()));
        } else {
          configuration("Report format must be json or csv");
        }
        return 0;
      }
      configuration("Unknown command");
    } finally {
      await store.close();
    }
  } catch (error) {
    const known = error instanceof ReconciliationError;
    json(dependencies.write, {
      error: {
        code: known ? error.code : "database_unavailable",
        message: known ? error.message : "PayOps reconciliation command failed",
        retryable: known ? error.retryable : true,
      },
    });
    return known && !error.retryable ? 2 : 1;
  }
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  process.exitCode = await runCli(process.argv.slice(2));
}
