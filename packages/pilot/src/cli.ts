import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { stringifyCanonical } from "@payops/core";
import { HttpSolanaRpc, PostgresIngestionStore } from "@payops/ingestion";
import { PostgresReconciliationStore } from "@payops/reconciliation";
import {
  PilotError,
  type ParsedPilotManifest,
  type RunShadowAuditResult,
} from "./domain/types.js";
import { parsePilotManifest } from "./manifest/parse-manifest.js";
import { createShadowAuditRunner } from "./orchestration/run-shadow-audit.js";
import { buildAuditArtifacts } from "./report/build-audit-report.js";
import { runPilotMigrations } from "./storage/migrate.js";
import { PostgresPilotStore } from "./storage/postgres-pilot-store.js";
import type { PilotRunInspection } from "./storage/types.js";

export interface RunAuditCommandInput {
  readonly databaseUrl: string;
  readonly parsed: ParsedPilotManifest;
  readonly privateOutputDirectory: string;
  readonly redactedOutputDirectory: string;
}

export interface PilotCliDependencies {
  readonly env: NodeJS.ProcessEnv;
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
  readonly loadManifest: (path: string) => Promise<ParsedPilotManifest>;
  readonly migrate: (databaseUrl: string) => Promise<void>;
  readonly runAudit: (
    input: RunAuditCommandInput,
  ) => Promise<RunShadowAuditResult>;
  readonly inspectRun: (
    databaseUrl: string,
    runId: string,
  ) => Promise<PilotRunInspection | null>;
}

export async function runCli(
  args: readonly string[],
  dependencies: PilotCliDependencies = defaultPilotCliDependencies,
): Promise<number> {
  try {
    if (args[0] === "migrate" && args.length === 1) {
      const databaseUrl = requiredOwnEnv(dependencies.env, "DATABASE_URL");
      await dependencies.migrate(databaseUrl);
      output(dependencies, { migrated: true });
      return 0;
    }

    if (args[0] !== "audit") throw invalidArguments();
    if (args[1] === "validate") {
      const flags = parseFlags(args.slice(2), new Set(["manifest"]));
      const parsed = await dependencies.loadManifest(flags.get("manifest")!);
      output(dependencies, {
        valid: true,
        pilotId: parsed.manifest.pilotId,
        digest: parsed.digest,
        invoiceDigest: parsed.manifest.invoices.expectedSha256,
        watches: parsed.manifest.watches.length,
      });
      return 0;
    }

    if (args[1] === "run") {
      const flags = parseFlags(
        args.slice(2),
        new Set(["manifest", "private-output", "redacted-output"]),
      );
      const parsed = await dependencies.loadManifest(flags.get("manifest")!);
      const databaseUrl = requiredOwnEnv(dependencies.env, "DATABASE_URL");
      requiredOwnEnv(dependencies.env, parsed.manifest.provider.endpointEnv);
      requiredOwnEnv(
        dependencies.env,
        parsed.manifest.reporting.pseudonymizationSecretEnv,
        32,
      );
      const privateOutputDirectory = resolve(flags.get("private-output")!);
      const redactedOutputDirectory = resolve(flags.get("redacted-output")!);
      if (privateOutputDirectory === redactedOutputDirectory) {
        throw invalidArguments();
      }
      const result = await dependencies.runAudit({
        databaseUrl,
        parsed,
        privateOutputDirectory,
        redactedOutputDirectory,
      });
      output(dependencies, result);
      return result.state === "complete" ? 0 : 1;
    }

    if (args[1] === "inspect") {
      const flags = parseFlags(args.slice(2), new Set(["run"]));
      const runId = flags.get("run")!;
      if (!uuidPattern.test(runId)) throw invalidArguments();
      const databaseUrl = requiredOwnEnv(dependencies.env, "DATABASE_URL");
      const inspection = await dependencies.inspectRun(databaseUrl, runId);
      if (inspection === null) {
        throw new PilotError("audit_incomplete", "Audit run was not found");
      }
      output(dependencies, inspection);
      return 0;
    }

    throw invalidArguments();
  } catch (error) {
    const safe = safeCliError(error);
    dependencies.stderr(`${safe.code}: ${safe.message}`);
    return safe.exitCode;
  }
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseFlags(
  args: readonly string[],
  allowed: ReadonlySet<string>,
): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (
      flag === undefined ||
      value === undefined ||
      !flag.startsWith("--") ||
      value.startsWith("--")
    ) {
      throw invalidArguments();
    }
    const name = flag.slice(2);
    if (!allowed.has(name) || flags.has(name) || value.length === 0) {
      throw invalidArguments();
    }
    flags.set(name, value);
  }
  if (flags.size !== allowed.size) throw invalidArguments();
  return flags;
}

function requiredOwnEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  minimumBytes = 1,
): string {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(env, name);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      typeof descriptor.value !== "string" ||
      Buffer.byteLength(descriptor.value, "utf8") < minimumBytes ||
      Buffer.byteLength(descriptor.value, "utf8") > 4096
    ) {
      throw invalidConfiguration();
    }
    return descriptor.value;
  } catch {
    throw invalidConfiguration();
  }
}

function output(dependencies: PilotCliDependencies, value: unknown): void {
  dependencies.stdout(stringifyCanonical(value).trimEnd());
}

function invalidArguments(): PilotError {
  return new PilotError(
    "invalid_configuration",
    "Command arguments are invalid",
  );
}

function invalidConfiguration(): PilotError {
  return new PilotError("invalid_configuration", "Configuration is invalid");
}

function safeCliError(error: unknown): {
  readonly code: string;
  readonly message: string;
  readonly exitCode: 1 | 2;
} {
  let code = "database_unavailable";
  try {
    const descriptor =
      error !== null &&
      (typeof error === "object" || typeof error === "function")
        ? Object.getOwnPropertyDescriptor(error, "code")
        : undefined;
    if (
      descriptor !== undefined &&
      "value" in descriptor &&
      typeof descriptor.value === "string" &&
      /^[a-z][a-z0-9_]{0,127}$/.test(descriptor.value)
    ) {
      code = descriptor.value;
    }
  } catch {
    code = "database_unavailable";
  }
  const invalid =
    code === "invalid_configuration" ||
    code === "invalid_manifest" ||
    code === "invoice_digest_mismatch" ||
    code === "unsafe_manifest_path";
  const messages: Readonly<Record<string, string>> = {
    invalid_configuration: "Configuration is invalid",
    invalid_manifest: "Manifest is invalid",
    invoice_digest_mismatch: "Invoice CSV digest does not match",
    unsafe_manifest_path: "Manifest path is unsafe",
    artifact_write_failed: "Audit artifacts could not be written",
    audit_incomplete: "Audit is incomplete",
    database_unavailable: "Audit operation failed",
  };
  return {
    code,
    message: messages[code] ?? "Audit operation failed",
    exitCode: invalid ? 2 : 1,
  };
}

export const defaultPilotCliDependencies: PilotCliDependencies = {
  env: process.env,
  stdout: (value) => process.stdout.write(`${value}\n`),
  stderr: (value) => process.stderr.write(`${value}\n`),
  loadManifest: async (path) => {
    const manifestPath = resolve(path);
    let raw: string;
    try {
      raw = await readFile(manifestPath, "utf8");
    } catch {
      throw new PilotError("invalid_manifest", "Pilot manifest is invalid");
    }
    return parsePilotManifest(raw, dirname(manifestPath));
  },
  migrate: runPilotMigrations,
  runAudit: async ({
    databaseUrl,
    parsed,
    privateOutputDirectory,
    redactedOutputDirectory,
  }) => {
    await runPilotMigrations(databaseUrl);
    const pilotStore = new PostgresPilotStore({ databaseUrl });
    const ingestionStore = new PostgresIngestionStore({
      databaseUrl,
      selfHostedDefaultOrganization: true,
    });
    const reconciliationStore = new PostgresReconciliationStore({
      databaseUrl,
      selfHostedDefaultOrganization: true,
    });
    const runner = createShadowAuditRunner({
      pilotStore,
      ingestionStore,
      reconciliationStore,
      makeRpc: (provider) =>
        new HttpSolanaRpc({
          cluster: provider.cluster,
          endpoint: requiredOwnEnv(process.env, provider.endpointEnv),
        }),
      readInvoiceCsv: async (path) => readFile(path, "utf8"),
      buildArtifacts: async (input) =>
        buildAuditArtifacts(input, {
          env: process.env,
          getAuditRows: (invoiceIds, watchTargetIds) =>
            reconciliationStore.getAuditRows(invoiceIds, watchTargetIds),
        }),
    });
    return runner({
      manifest: parsed.manifest,
      manifestCanonicalJson: parsed.canonicalJson,
      manifestDigest: parsed.digest,
      invoiceCsvPath: parsed.invoiceCsvPath,
      privateOutputDirectory,
      redactedOutputDirectory,
      now: () => new Date(),
    });
  },
  inspectRun: async (databaseUrl, runId) => {
    const store = new PostgresPilotStore({ databaseUrl });
    try {
      return await store.getRun(runId);
    } finally {
      await store.close();
    }
  },
};
