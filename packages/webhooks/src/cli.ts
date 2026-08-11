#!/usr/bin/env node
import { stringifyCanonical } from "@payops/core";
import {
  runDeliveryBatch,
  type DeliveryBatchOptions,
  type DeliveryBatchResult,
  type DeliveryEnvironment,
  type DeliveryStore,
  type DeliveryTransport,
} from "./delivery/worker.js";
import { UnsafeEndpointError } from "./security/endpoint-policy.js";
import { runMigrations } from "./storage/migrate.js";
import { PostgresWebhookStore } from "./storage/postgres-webhook-store.js";
import type {
  AddEndpointInput,
  WebhookEndpointRecord,
  WebhookEventInspection,
} from "./storage/types.js";
import { WebhookStorageError } from "./storage/types.js";
import { UndiciWebhookTransport } from "./transport/https-transport.js";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const secretEnvironmentPattern = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const deliveryLeaseMs = 60_000;
const defaultDeliveryConcurrency = 8;

interface OperatorWebhookStore extends DeliveryStore {
  addEndpoint(
    input: AddEndpointInput,
    createdAt: Date,
  ): Promise<{ readonly inserted: boolean }>;
  rotateEndpointSecret(
    endpointId: string,
    secretEnv: string,
    updatedAt: Date,
  ): Promise<{ readonly rotated: boolean }>;
  listEndpoints(): Promise<readonly WebhookEndpointRecord[]>;
  replayDelivery(deliveryId: string, now: Date): Promise<boolean>;
  inspectEvent(eventId: string): Promise<WebhookEventInspection | null>;
  close(): Promise<void>;
}

interface ClosableDeliveryTransport extends DeliveryTransport {
  close?(): Promise<void>;
}

export interface WebhookCliDependencies {
  env: NodeJS.ProcessEnv;
  readonly write: (line: string) => void;
  readonly now: () => Date;
  readonly migrate: (databaseUrl: string) => Promise<void>;
  readonly createStore: (databaseUrl: string) => OperatorWebhookStore;
  readonly createTransport: () => ClosableDeliveryTransport;
  readonly deliver: (
    store: DeliveryStore,
    transport: DeliveryTransport,
    env: DeliveryEnvironment,
    options: DeliveryBatchOptions,
  ) => Promise<DeliveryBatchResult>;
}

const defaults: WebhookCliDependencies = {
  env: process.env,
  write: (line) => process.stdout.write(`${line}\n`),
  now: () => new Date(),
  migrate: runMigrations,
  createStore: (databaseUrl) =>
    new PostgresWebhookStore({
      databaseUrl,
      selfHostedDefaultOrganization: true,
    }),
  createTransport: () => new UndiciWebhookTransport(),
  deliver: runDeliveryBatch,
};

class WebhookCliError extends Error {
  public constructor(
    readonly code: string,
    message: string,
    readonly exitCode: 1 | 2,
  ) {
    super(message);
    this.name = "WebhookCliError";
  }
}

function configuration(message: string): never {
  throw new WebhookCliError("invalid_configuration", message, 2);
}

function operational(code: string, message: string): never {
  throw new WebhookCliError(code, message, 1);
}

function json(write: WebhookCliDependencies["write"], value: unknown): void {
  write(stringifyCanonical(toJsonBoundary(value)).trimEnd());
}

function toJsonBoundary(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(toJsonBoundary);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, toJsonBoundary(entry)]),
    );
  }
  return value;
}

export async function runCli(
  argv: readonly string[],
  dependencies: WebhookCliDependencies = defaults,
): Promise<number> {
  try {
    const databaseUrl = requiredDatabaseUrl(dependencies.env);
    if (argv.length === 1 && argv[0] === "migrate") {
      await dependencies.migrate(databaseUrl);
      json(dependencies.write, { migrated: true });
      return 0;
    }

    const store = dependencies.createStore(databaseUrl);
    try {
      return await runStoreCommand(argv, store, dependencies);
    } finally {
      await store.close();
    }
  } catch (error) {
    const known = knownError(error);
    json(dependencies.write, {
      error: known ?? {
        code: "database_unavailable",
        message: "PayOps webhook command failed",
        retryable: true,
      },
    });
    return known?.retryable === false ? 2 : 1;
  }
}

async function runStoreCommand(
  argv: readonly string[],
  store: OperatorWebhookStore,
  dependencies: WebhookCliDependencies,
): Promise<number> {
  const [command, subcommand, ...rest] = argv;
  if (command === "endpoint" && subcommand === "add") {
    const options = exactOptions(rest, ["id", "url", "secret-env"]);
    const secretEnv = options["secret-env"]!;
    requireSecretReference(dependencies.env, secretEnv);
    const result = await store.addEndpoint(
      { id: options.id!, url: options.url!, secretEnv },
      dependencies.now(),
    );
    json(dependencies.write, { endpointId: options.id, ...result });
    return 0;
  }
  if (command === "endpoint" && subcommand === "rotate-secret") {
    const options = exactOptions(rest, ["id", "secret-env"]);
    const secretEnv = options["secret-env"]!;
    requireSecretReference(dependencies.env, secretEnv);
    const result = await store.rotateEndpointSecret(
      options.id!,
      secretEnv,
      dependencies.now(),
    );
    json(dependencies.write, { endpointId: options.id, ...result });
    return 0;
  }
  if (command === "endpoint" && subcommand === "list" && rest.length === 0) {
    json(dependencies.write, { endpoints: await store.listEndpoints() });
    return 0;
  }
  if (command === "deliver" && subcommand === "--limit") {
    const options = deliveryOptions(argv.slice(1));
    const limit = boundedInteger(options.limit!, "Delivery limit", 256);
    const concurrency = boundedInteger(
      options.concurrency ?? String(defaultDeliveryConcurrency),
      "Delivery concurrency",
      32,
    );
    const transport = dependencies.createTransport();
    try {
      json(
        dependencies.write,
        await dependencies.deliver(store, transport, dependencies.env, {
          limit,
          leaseMs: deliveryLeaseMs,
          concurrency,
          now: dependencies.now,
        }),
      );
      return 0;
    } finally {
      await transport.close?.();
    }
  }
  if (command === "delivery" && subcommand === "replay") {
    const id = exactOptions(rest, ["id"]).id!;
    requireUuid(id, "Delivery ID");
    if (!(await store.replayDelivery(id, dependencies.now()))) {
      operational(
        "delivery_not_replayable",
        "Webhook delivery was not found or is currently active",
      );
    }
    json(dependencies.write, { deliveryId: id, replayed: true });
    return 0;
  }
  if (command === "inspect" && subcommand === "event") {
    const id = exactOptions(rest, ["id"]).id!;
    requireUuid(id, "Event ID");
    const event = await store.inspectEvent(id);
    if (event === null) {
      operational("event_not_found", "Webhook event was not found");
    }
    json(dependencies.write, inspectionOutput(event));
    return 0;
  }
  configuration("Unknown command or invalid arguments");
}

function deliveryOptions(
  args: readonly string[],
): Readonly<Record<string, string>> {
  if (args.length !== 2 && args.length !== 4) {
    configuration("Expected --limit and optional --concurrency");
  }
  const options: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (
      option === undefined ||
      value === undefined ||
      !option.startsWith("--") ||
      value.startsWith("--")
    ) {
      configuration("Options require values");
    }
    const name = option.slice(2);
    if (
      (name !== "limit" && name !== "concurrency") ||
      Object.hasOwn(options, name)
    ) {
      configuration(`Unknown or repeated --${name} option`);
    }
    options[name] = value;
  }
  if (options.limit === undefined) {
    configuration("Missing required --limit option");
  }
  return options;
}

function exactOptions(
  args: readonly string[],
  names: readonly string[],
): Readonly<Record<string, string>> {
  if (args.length !== names.length * 2) {
    configuration(`Expected ${names.map((name) => `--${name}`).join(", ")}`);
  }
  const expected = new Set(names);
  const options: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (
      option === undefined ||
      value === undefined ||
      !option.startsWith("--") ||
      value.startsWith("--")
    ) {
      configuration("Options require values");
    }
    const name = option.slice(2);
    if (!expected.has(name) || Object.hasOwn(options, name)) {
      configuration(`Unknown or repeated --${name} option`);
    }
    options[name] = value;
  }
  if (Object.keys(options).length !== expected.size) {
    configuration("Missing required option");
  }
  return options;
}

function requiredDatabaseUrl(env: NodeJS.ProcessEnv): string {
  const value = env.DATABASE_URL;
  if (value === undefined || value.length === 0) {
    configuration("DATABASE_URL is not set");
  }
  return value;
}

function requireSecretReference(env: NodeJS.ProcessEnv, name: string): void {
  if (!secretEnvironmentPattern.test(name)) {
    configuration("Secret environment variable name has invalid syntax");
  }
  const value = Object.hasOwn(env, name) ? env[name] : undefined;
  if (value === undefined || value.length === 0) {
    configuration(`Secret environment variable ${name} is not set or is empty`);
  }
}

function boundedInteger(value: string, label: string, maximum: number): number {
  if (!/^[1-9][0-9]*$/.test(value)) {
    configuration(`${label} must be an integer from 1 to ${maximum}`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number > maximum) {
    configuration(`${label} must be an integer from 1 to ${maximum}`);
  }
  return number;
}

function requireUuid(value: string, label: string): void {
  if (!uuidPattern.test(value)) configuration(`${label} must be a UUID`);
}

function inspectionOutput(event: WebhookEventInspection): unknown {
  const { payload: _payload, digest, ...metadata } = event;
  return { ...metadata, payloadDigest: digest };
}

function knownError(error: unknown):
  | {
      readonly code: string;
      readonly message: string;
      readonly retryable: boolean;
    }
  | undefined {
  if (error instanceof WebhookCliError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.exitCode === 1,
    };
  }
  if (error instanceof UnsafeEndpointError) {
    return { code: error.code, message: error.message, retryable: false };
  }
  if (error instanceof WebhookStorageError) {
    const usage =
      error.code === "invalid_storage_input" ||
      error.code === "endpoint_conflict";
    return { code: error.code, message: error.message, retryable: !usage };
  }
  return undefined;
}
