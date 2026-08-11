#!/usr/bin/env node
import { bootstrapOwner } from "./auth/bootstrap.js";
import { HttpEmailDeliveryPort } from "./auth/http-email-port.js";

void main().catch((error: unknown) => {
  process.stderr.write(`${safeCode(error)}\n`);
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const [command, ...arguments_] = process.argv.slice(2);
  if (command !== "bootstrap-owner") throw new Error("invalid_command");
  const organizationName = requiredFlag(arguments_, "--organization-name");
  const email = requiredFlag(arguments_, "--email");
  if (arguments_.length !== 4) throw new Error("invalid_arguments");
  const result = await bootstrapOwner(
    {
      organizationName,
      email,
      invitationBaseUrl: requiredEnvironment("PAYOPS_BOOTSTRAP_INVITATION_URL"),
      now: new Date(),
    },
    {
      databaseUrl: requiredEnvironment("DATABASE_URL"),
      email: new HttpEmailDeliveryPort({
        endpoint: requiredEnvironment("PAYOPS_AUTH_EMAIL_ENDPOINT"),
        bearerToken: requiredEnvironment("PAYOPS_AUTH_EMAIL_TOKEN"),
      }),
    },
  );
  process.stdout.write(
    `${JSON.stringify({
      organizationId: result.organizationId,
      invitationId: result.invitationId,
      expiresAt: result.expiresAt.toISOString(),
    })}\n`,
  );
}

function requiredFlag(arguments_: readonly string[], name: string): string {
  const positions = arguments_
    .map((value, index) => (value === name ? index : -1))
    .filter((index) => index >= 0);
  if (positions.length !== 1) throw new Error("invalid_arguments");
  const value = arguments_[positions[0]! + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error("invalid_arguments");
  }
  return value;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("missing_configuration");
  }
  return value;
}

function safeCode(error: unknown): string {
  try {
    if (
      error !== null &&
      (typeof error === "object" || typeof error === "function")
    ) {
      const descriptor = Object.getOwnPropertyDescriptor(error, "code");
      if (
        descriptor !== undefined &&
        "value" in descriptor &&
        typeof descriptor.value === "string" &&
        /^[a-z][a-z0-9_]{0,127}$/.test(descriptor.value)
      ) {
        return descriptor.value;
      }
    }
  } catch {
    return "platform_command_failed";
  }
  return "platform_command_failed";
}
