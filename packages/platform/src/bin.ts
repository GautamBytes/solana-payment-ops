#!/usr/bin/env node
import { createHash } from "node:crypto";
import { bootstrapOwner } from "./auth/bootstrap.js";
import { HttpEmailDeliveryPort } from "./auth/http-email-port.js";
import { verifyEvidencePack } from "./operations/evidence-pack.js";
import { readBoundedFile } from "./operations/read-bounded-file.js";
import { bootstrapProductionDatabaseRoles } from "./db/production-role-bootstrap.js";

void main().catch((error: unknown) => {
  process.stderr.write(`${safeCode(error)}\n`);
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const [command, ...arguments_] = process.argv.slice(2);
  if (command === "verify-evidence") {
    await verifyEvidence(arguments_);
    return;
  }
  if (command === "bootstrap-production-roles") {
    if (arguments_.length !== 10) throw commandError("invalid_arguments");
    const roles = await bootstrapProductionDatabaseRoles(
      requiredEnvironment("PAYOPS_DATABASE_ADMIN_URL"),
      {
        migrator: requiredFlag(arguments_, "--migrator-role"),
        runtime: requiredFlag(arguments_, "--runtime-role"),
        control: requiredFlag(arguments_, "--control-role"),
        readinessVerifier: requiredFlag(
          arguments_,
          "--readiness-verifier-role",
        ),
        shadowProjector: requiredFlag(arguments_, "--shadow-projector-role"),
      },
    );
    process.stdout.write(`${JSON.stringify(roles)}\n`);
    return;
  }
  if (command !== "bootstrap-owner") throw commandError("invalid_command");
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

async function verifyEvidence(arguments_: readonly string[]): Promise<void> {
  if (arguments_.length !== 8) throw commandError("invalid_arguments");
  const manifestPath = requiredFlag(arguments_, "--manifest");
  const pdfPath = requiredFlag(arguments_, "--pdf");
  const signatureText = requiredFlag(arguments_, "--signature");
  const publicKeyPath = requiredFlag(arguments_, "--public-key");
  if (!/^[A-Za-z0-9_-]{86}$/u.test(signatureText)) {
    throw commandError("invalid_evidence_signature");
  }
  const manifestBytes = await readBoundedFile(manifestPath, 10_485_760);
  const pdfBytes = await readBoundedFile(pdfPath, 10_485_760);
  const publicKeyPem = new TextDecoder("utf-8", { fatal: true }).decode(
    await readBoundedFile(publicKeyPath, 16_384),
  );
  const manifestDigest = createHash("sha256")
    .update(manifestBytes)
    .digest("hex");
  const valid = verifyEvidencePack(
    {
      manifestBytes,
      pdfBytes,
      manifestDigest,
      signature: new Uint8Array(Buffer.from(signatureText, "base64url")),
    },
    publicKeyPem,
  );
  if (!valid) throw commandError("evidence_signature_invalid");
  process.stdout.write(`${JSON.stringify({ valid: true, manifestDigest })}\n`);
}

function requiredFlag(arguments_: readonly string[], name: string): string {
  const positions = arguments_
    .map((value, index) => (value === name ? index : -1))
    .filter((index) => index >= 0);
  if (positions.length !== 1) throw commandError("invalid_arguments");
  const value = arguments_[positions[0]! + 1];
  if (value === undefined || value.startsWith("--")) {
    throw commandError("invalid_arguments");
  }
  return value;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0) {
    throw commandError("missing_configuration");
  }
  return value;
}

function commandError(code: string): Error & { readonly code: string } {
  return Object.assign(new Error("Platform command failed"), { code });
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
