import { createHash } from "node:crypto";
import postgres from "postgres";
import {
  bootstrapProductionDatabaseRoles,
  runPlatformMigrations,
  type ProductionDatabasePrincipals,
  type ProductionDatabaseRoles,
} from "../src/index.js";

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
  await prepareTestProductionRoleBoundary(databaseUrl);
  await runPlatformMigrations(databaseUrl);
}

export async function prepareTestProductionRoleBoundary(
  databaseUrl: string,
): Promise<{
  readonly principals: ProductionDatabasePrincipals;
  readonly roles: ProductionDatabaseRoles;
}> {
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
  const boundary = { principals, roles };
  boundaries.set(databaseUrl, boundary);
  return boundary;
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
    migrator: `payops_test_${scope}_migrator`,
    runtime: `payops_test_${scope}_runtime`,
    control: `payops_test_${scope}_control`,
    readinessVerifier: `payops_test_${scope}_verifier`,
    shadowProjector: `payops_test_${scope}_projector`,
  };
}
