#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { address } from "@solana/kit";
import { stringifyCanonical } from "@payops/core";
import { createCanonicalSnapshot } from "./archive/canonical-snapshot.js";
import { createBackfillEngine } from "./backfill/backfill-engine.js";
import type {
  IngestionStore,
  SolanaCluster,
  SolanaRpcPort,
  WatchTarget,
} from "./domain/types.js";
import { IngestionError } from "./domain/types.js";
import { createFinalityEngine } from "./finality/finality-engine.js";
import {
  HttpSolanaRpc,
  type HttpSolanaRpcConfig,
} from "./rpc/http-solana-rpc.js";
import { runMigrations } from "./storage/migrate.js";
import { PostgresIngestionStore } from "./storage/postgres-store.js";

export interface CliDependencies {
  readonly env: NodeJS.ProcessEnv;
  readonly write: (line: string) => void;
  readonly createStore: (databaseUrl: string) => IngestionStore;
  readonly createRpc: (config: HttpSolanaRpcConfig) => SolanaRpcPort;
  readonly migrate: (databaseUrl: string) => Promise<void>;
  readonly now: () => Date;
  readonly createId: () => string;
}

const defaultDependencies: CliDependencies = {
  env: process.env,
  write: (line) => process.stdout.write(`${line}\n`),
  createStore: (databaseUrl) => new PostgresIngestionStore({ databaseUrl }),
  createRpc: (config) => new HttpSolanaRpc(config),
  migrate: runMigrations,
  now: () => new Date(),
  createId: randomUUID,
};

function parseFlags(
  args: readonly string[],
  booleanFlags: ReadonlySet<string> = new Set(),
): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === undefined || !flag.startsWith("--")) {
      throw new IngestionError(
        "invalid_configuration",
        "Every option must start with --name",
        { retryable: false },
      );
    }
    const name = flag.slice(2);
    if (flags.has(name)) {
      throw new IngestionError(
        "invalid_configuration",
        `Option --${name} cannot be repeated`,
        { retryable: false },
      );
    }
    if (booleanFlags.has(name)) {
      flags.set(name, "true");
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new IngestionError(
        "invalid_configuration",
        "Every value option must use --name value syntax",
        { retryable: false },
      );
    }
    flags.set(name, value);
    index += 1;
  }
  return flags;
}

function required(flags: Map<string, string>, name: string): string {
  const value = flags.get(name);
  if (value === undefined || value.length === 0) {
    throw new IngestionError(
      "invalid_configuration",
      `Missing required --${name} option`,
      { retryable: false },
    );
  }
  return value;
}

function parseCluster(value: string): SolanaCluster {
  if (value === "mainnet-beta" || value === "devnet" || value === "localnet") {
    return value;
  }
  throw new IngestionError(
    "invalid_configuration",
    "Cluster must be mainnet-beta, devnet, or localnet",
    { retryable: false },
  );
}

function parseUnsigned(value: string, name: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new IngestionError(
      "invalid_configuration",
      `${name} must be an unsigned integer`,
      { retryable: false },
    );
  }
  const parsed = BigInt(value);
  if (parsed > 99_999_999_999_999_999_999n) {
    throw new IngestionError(
      "invalid_configuration",
      `${name} exceeds the PostgreSQL numeric(20,0) range`,
      { retryable: false },
    );
  }
  return parsed;
}

function parsePositiveSafeInteger(value: string, name: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new IngestionError(
      "invalid_configuration",
      `${name} must be a positive integer`,
      { retryable: false },
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new IngestionError(
      "invalid_configuration",
      `${name} is outside the safe integer range`,
      { retryable: false },
    );
  }
  return parsed;
}

function output(dependencies: CliDependencies, value: unknown): void {
  dependencies.write(stringifyCanonical(toJsonBoundary(value)).trimEnd());
}

function toJsonBoundary(value: unknown): unknown {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map(toJsonBoundary);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, toJsonBoundary(entry)]),
    );
  }
  return value;
}

function serializeWatchTarget(target: WatchTarget): Record<string, unknown> {
  return {
    ...target,
    cutoverSlot: target.cutoverSlot.toString(),
    overlapSlots: target.overlapSlots.toString(),
    committedHeadSlot: target.committedHeadSlot?.toString() ?? null,
  };
}

function safeError(error: unknown): {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
} {
  if (error instanceof IngestionError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  }
  return {
    code: "database_unavailable",
    message: "PayOps command failed",
    retryable: true,
  };
}

async function providerRpc(
  store: IngestionStore,
  providerId: string,
  dependencies: CliDependencies,
): Promise<SolanaRpcPort> {
  const provider = await store.getProvider(providerId);
  if (provider === null) {
    throw new IngestionError(
      "invalid_configuration",
      "Provider was not found",
      {
        retryable: false,
      },
    );
  }
  const endpoint = dependencies.env[provider.endpointEnv];
  if (endpoint === undefined || endpoint.length === 0) {
    throw new IngestionError(
      "invalid_configuration",
      `Provider environment variable ${provider.endpointEnv} is not set`,
      { retryable: false },
    );
  }
  return dependencies.createRpc({ cluster: provider.cluster, endpoint });
}

export async function runCli(
  argv: readonly string[],
  dependencies: CliDependencies = defaultDependencies,
): Promise<number> {
  try {
    const databaseUrl = dependencies.env.DATABASE_URL;
    if (databaseUrl === undefined || databaseUrl.length === 0) {
      throw new IngestionError(
        "invalid_configuration",
        "DATABASE_URL is not set",
        { retryable: false },
      );
    }
    const [command, subcommand, ...rest] = argv;
    if (command === "migrate" && subcommand === undefined) {
      await dependencies.migrate(databaseUrl);
      output(dependencies, { migrated: true });
      return 0;
    }

    const store = dependencies.createStore(databaseUrl);
    try {
      if (command === "provider" && subcommand === "add") {
        const flags = parseFlags(rest);
        const id = required(flags, "id");
        const cluster = parseCluster(required(flags, "cluster"));
        const endpointEnv = required(flags, "url-env");
        if (!/^[A-Z][A-Z0-9_]*$/.test(endpointEnv)) {
          throw new IngestionError(
            "invalid_configuration",
            "Provider URL environment name is invalid",
            { retryable: false },
          );
        }
        const endpoint = dependencies.env[endpointEnv];
        if (endpoint === undefined) {
          throw new IngestionError(
            "invalid_configuration",
            `Provider environment variable ${endpointEnv} is not set`,
            { retryable: false },
          );
        }
        let endpointLabel: string;
        try {
          endpointLabel = new URL(endpoint).host;
        } catch (cause) {
          throw new IngestionError(
            "invalid_configuration",
            "Provider URL is invalid",
            { retryable: false, cause },
          );
        }
        const provider = await store.addProvider({
          id,
          cluster,
          endpointEnv,
          endpointLabel,
        });
        output(dependencies, provider);
        return 0;
      }

      if (command === "watch" && subcommand === "add") {
        const flags = parseFlags(rest);
        const providerId = required(flags, "provider");
        const rawAddress = required(flags, "address");
        try {
          address(rawAddress);
        } catch (cause) {
          throw new IngestionError(
            "invalid_configuration",
            "Watch address is not a valid Solana address",
            { retryable: false, cause },
          );
        }
        const provider = await store.getProvider(providerId);
        if (provider === null) {
          throw new IngestionError(
            "invalid_configuration",
            "Provider was not found",
            { retryable: false },
          );
        }
        const overlapSlots = parseUnsigned(
          flags.get("overlap") ?? "150",
          "overlap",
        );
        if (overlapSlots < 32n) {
          throw new IngestionError(
            "invalid_configuration",
            "Overlap must be at least 32 slots",
            { retryable: false },
          );
        }
        let cutoverSlot: bigint;
        let cutoverSignature: string | null = null;
        if (flags.get("from") === "latest") {
          const rpc = await providerRpc(store, providerId, dependencies);
          cutoverSlot = await rpc.getSlot("confirmed");
          const head = await rpc.getSignaturesForAddress({
            address: rawAddress,
            commitment: "confirmed",
            limit: 1,
          });
          cutoverSignature = head[0]?.signature ?? null;
        } else {
          cutoverSlot = parseUnsigned(
            required(flags, "from-slot"),
            "from-slot",
          );
        }
        const target = await store.addWatchTarget({
          id: flags.get("id") ?? dependencies.createId(),
          providerId,
          cluster: provider.cluster,
          address: rawAddress,
          cutoverSlot,
          cutoverSignature,
          overlapSlots,
          createdAt: dependencies.now(),
        });
        output(dependencies, serializeWatchTarget(target));
        return 0;
      }

      if (command === "sync" && subcommand?.startsWith("--")) {
        const flags = parseFlags([subcommand, ...rest]);
        const providerId = required(flags, "provider");
        const watchTargetId = required(flags, "watch");
        const rpc = await providerRpc(store, providerId, dependencies);
        const report = await createBackfillEngine({
          rpc,
          store,
        }).syncWatchTarget({
          providerId,
          watchTargetId,
          now: dependencies.now(),
        });
        output(dependencies, report);
        return report.result === "complete" || report.result === "busy" ? 0 : 1;
      }

      if (command === "finality" && subcommand === "refresh") {
        const flags = parseFlags(rest);
        const providerId = required(flags, "provider");
        const limit = parsePositiveSafeInteger(
          required(flags, "limit"),
          "limit",
        );
        const rpc = await providerRpc(store, providerId, dependencies);
        const report = await createFinalityEngine({ rpc, store }).refresh({
          providerId,
          limit,
          now: dependencies.now(),
        });
        output(dependencies, report);
        return report.quarantined > 0 || report.retriesCreated > 0 ? 1 : 0;
      }

      if (command === "inspect" && subcommand === "watch") {
        const target = await store.getWatchTarget(
          required(parseFlags(rest), "watch"),
        );
        output(
          dependencies,
          target === null ? null : serializeWatchTarget(target),
        );
        return target === null ? 1 : 0;
      }

      if (command === "inspect" && subcommand === "signature") {
        const flags = parseFlags(rest, new Set(["include-raw"]));
        const result = await store.inspectSignature(
          required(flags, "signature"),
          { includeRaw: flags.has("include-raw") },
        );
        output(dependencies, result);
        return result === null ? 1 : 0;
      }

      if (command === "rpc-smoke" && subcommand?.startsWith("--")) {
        const flags = parseFlags([subcommand, ...rest]);
        const providerId = required(flags, "provider");
        const rawAddress = required(flags, "address");
        try {
          address(rawAddress);
        } catch (cause) {
          throw new IngestionError(
            "invalid_configuration",
            "RPC smoke address is not a valid Solana address",
            { retryable: false, cause },
          );
        }
        const rpc = await providerRpc(store, providerId, dependencies);
        const [slot, head] = await Promise.all([
          rpc.getSlot("confirmed"),
          rpc.getSignaturesForAddress({
            address: rawAddress,
            commitment: "confirmed",
            limit: 1,
          }),
        ]);
        const headEntry = head[0] ?? null;
        const transaction =
          headEntry === null
            ? null
            : await rpc.getTransaction(headEntry.signature, "confirmed");
        const snapshot =
          transaction === null ? null : createCanonicalSnapshot(transaction);
        output(dependencies, {
          providerId,
          confirmedSlot: slot.toString(),
          headSignature: headEntry?.signature ?? null,
          transactionAvailable: transaction !== null,
          transactionSlot: transaction?.slot.toString() ?? null,
          transactionDigest: snapshot?.digest ?? null,
        });
        return headEntry !== null && transaction === null ? 1 : 0;
      }

      throw new IngestionError(
        "invalid_configuration",
        "Unknown PayOps ingestion command",
        { retryable: false },
      );
    } finally {
      await store.close();
    }
  } catch (error) {
    const safe = safeError(error);
    output(dependencies, { error: safe });
    return safe.retryable ? 1 : 2;
  }
}

const entryPath = process.argv[1];
if (
  entryPath !== undefined &&
  resolve(entryPath) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await runCli(process.argv.slice(2));
}
