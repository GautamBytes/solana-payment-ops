import { createHash } from "node:crypto";
import {
  bootstrapProductionDatabaseRoles,
  runPlatformMigrations,
  type ProductionDatabasePrincipals,
  type ProductionDatabaseRoles,
} from "@payops/platform";
import postgres from "postgres";

const boundaries = new Map<
  string,
  {
    readonly principals: ProductionDatabasePrincipals;
    readonly roles: ProductionDatabaseRoles;
  }
>();

export async function runTestPlatformMigrations(
  databaseUrl: string,
): Promise<void> {
  const principals = testPrincipals(databaseUrl);
  const admin = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  try {
    for (const role of Object.values(principals)) {
      await admin.unsafe(`
        DO $test_role$ BEGIN
          CREATE ROLE ${role} LOGIN INHERIT NOSUPERUSER NOBYPASSRLS
            NOCREATEDB NOCREATEROLE NOREPLICATION;
        EXCEPTION WHEN duplicate_object THEN NULL;
        END $test_role$
      `);
    }
  } finally {
    await admin.end();
  }
  const roles = await bootstrapProductionDatabaseRoles(databaseUrl, principals);
  boundaries.set(databaseUrl, { principals, roles });
  await runPlatformMigrations(databaseUrl);
}

export async function cleanupTestProductionRoles(
  databaseUrl: string,
): Promise<void> {
  const boundary = boundaries.get(databaseUrl);
  if (boundary === undefined) return;
  const admin = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  try {
    for (const role of [
      ...Object.values(boundary.principals),
      ...Object.values(boundary.roles),
    ]) {
      await admin.unsafe(`DROP ROLE IF EXISTS ${role}`);
    }
  } finally {
    boundaries.delete(databaseUrl);
    await admin.end();
  }
}

export function testProductionBoundary(databaseUrl: string) {
  const boundary = boundaries.get(databaseUrl);
  if (boundary === undefined)
    throw new Error("test_production_boundary_missing");
  return boundary;
}

export function testProductionRoleDatabaseUrls(databaseUrl: string) {
  const { principals } = testProductionBoundary(databaseUrl);
  return {
    runtime: withRole(databaseUrl, principals.runtime),
    control: withRole(databaseUrl, principals.control),
    readinessVerifier: withRole(databaseUrl, principals.readinessVerifier),
  };
}

function withRole(databaseUrl: string, role: string): string {
  const url = new URL(databaseUrl);
  const existing = url.searchParams.get("options");
  url.searchParams.set(
    "options",
    [existing, `-c role=${role}`].filter(Boolean).join(" "),
  );
  return url.toString();
}

function testPrincipals(databaseUrl: string): ProductionDatabasePrincipals {
  const url = new URL(databaseUrl);
  const scope = createHash("sha256")
    .update(
      `${url.pathname}:${url.searchParams.get("options") ?? "public"}`,
      "utf8",
    )
    .digest("hex")
    .slice(0, 12);
  return {
    migrator: `payops_api_${scope}_migrator`,
    runtime: `payops_api_${scope}_runtime`,
    control: `payops_api_${scope}_control`,
    readinessVerifier: `payops_api_${scope}_verifier`,
    shadowProjector: `payops_api_${scope}_projector`,
  };
}
