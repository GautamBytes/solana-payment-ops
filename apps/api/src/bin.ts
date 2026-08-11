#!/usr/bin/env node
import { HttpEmailDeliveryPort } from "@payops/platform";
import { parseApiConfig } from "./config.js";
import { buildApiServer } from "./server.js";

void main().catch((error: unknown) => {
  process.stderr.write(`${safeCode(error)}\n`);
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const config = parseApiConfig(process.env);
  const endpoint = requiredEnvironment("PAYOPS_AUTH_EMAIL_ENDPOINT");
  const bearerToken = requiredEnvironment("PAYOPS_AUTH_EMAIL_TOKEN");
  const server = buildApiServer(config, {
    emailDelivery: new HttpEmailDeliveryPort({ endpoint, bearerToken }),
  });
  const port = parsePort(process.env.PAYOPS_API_PORT ?? "3000");
  const host = process.env.PAYOPS_API_HOST ?? "127.0.0.1";
  await server.listen({ host, port });
  const close = async () => {
    await server.close();
  };
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
}

function safeCode(error: unknown): string {
  if (
    error === null ||
    (typeof error !== "object" && typeof error !== "function")
  ) {
    return "invalid_configuration";
  }
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
    return "invalid_configuration";
  }
  return "invalid_configuration";
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0) {
    throw Object.assign(new Error("Missing configuration"), {
      code: "missing_configuration",
    });
  }
  return value;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw Object.assign(new Error("Invalid port"), {
      code: "invalid_api_port",
    });
  }
  return port;
}
