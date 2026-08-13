import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { runMigrations as runIngestionMigrations } from "@payops/ingestion";
import { runMigrations as runReconciliationMigrations } from "@payops/reconciliation";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import {
  bootstrapProductionDatabaseRoles,
  runMigrationSet,
  runPlatformMigrations,
  type ProductionDatabasePrincipals,
  type ProductionDatabaseRoles,
} from "../src/index.js";

const baseDatabaseUrl = process.env.DATABASE_URL;
const describeDatabase = baseDatabaseUrl ? describe : describe.skip;
const suffix = `${process.pid}_${randomUUID().slice(0, 8)}`;
const password = `Role-${randomUUID()}-aA1!`;
const admin = baseDatabaseUrl
  ? postgres(baseDatabaseUrl, { max: 2, onnotice: () => undefined })
  : undefined;
const schemas: string[] = [];
const rolesToDrop: string[] = [];
const capabilityRoles: ProductionDatabaseRoles[] = [];

describeDatabase("production role bootstrap hardening", () => {
  afterAll(async () => {
    for (const trigger of [`payops_fail_bootstrap_${suffix}`]) {
      await admin!.unsafe(`DROP EVENT TRIGGER IF EXISTS ${trigger}`);
    }
    for (const schema of schemas) {
      await admin!.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    }
    for (const role of [
      ...rolesToDrop.reverse(),
      ...capabilityRoles.flatMap((value) => Object.values(value)),
    ]) {
      await admin!.unsafe(`DROP ROLE IF EXISTS ${role}`);
    }
    await admin?.end();
  });

  it("rejects a principal with a transitive path to a privileged parent", async () => {
    const schema = await createSchema("transitive");
    const principals = await createPrincipals("transitive");
    const privileged = registerRole(`payops_privileged_${suffix}`);
    const bridge = registerRole(`payops_bridge_${suffix}`);
    await admin!.unsafe(`CREATE ROLE ${privileged} NOLOGIN CREATEROLE`);
    await admin!.unsafe(`CREATE ROLE ${bridge} NOLOGIN`);
    await admin!.unsafe(`GRANT ${privileged} TO ${bridge}`);
    await admin!.unsafe(`GRANT ${bridge} TO ${principals.runtime}`);

    let failure: unknown;
    try {
      const unexpected = await bootstrapProductionDatabaseRoles(
        withSearchPath(baseDatabaseUrl!, schema),
        principals,
      );
      capabilityRoles.push(unexpected);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: "production_principal_has_unsafe_role_path",
    });
  });

  it("rejects a transitive path from one principal into another capability", async () => {
    const schema = await createSchema("cross_capability");
    const principals = await createPrincipals("cross_capability");
    const adminUrl = withSearchPath(baseDatabaseUrl!, schema);
    const provisioned = await bootstrapProductionDatabaseRoles(
      adminUrl,
      principals,
    );
    capabilityRoles.push(provisioned);
    const bridge = registerRole(`payops_cross_bridge_${suffix}`);
    await admin!.unsafe(`CREATE ROLE ${bridge} NOLOGIN`);
    await admin!.unsafe(`GRANT ${provisioned.control} TO ${bridge}`);
    await admin!.unsafe(`GRANT ${bridge} TO ${principals.runtime}`);

    await expect(
      bootstrapProductionDatabaseRoles(adminUrl, principals),
    ).rejects.toMatchObject({
      code: "production_principal_has_unsafe_role_path",
    });
  });

  it("provisions migrations through a genuine non-superuser role administrator", async () => {
    const roleAdmin = registerRole(`payops_role_admin_${suffix}`);
    await admin!.unsafe(
      `CREATE ROLE ${roleAdmin} LOGIN PASSWORD '${password}' CREATEROLE INHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOREPLICATION`,
    );
    const roleAdminUrl = asRoleUrl(baseDatabaseUrl!, roleAdmin);
    const roleAdminSql = postgres(roleAdminUrl, { max: 1 });
    const schema = `payops_role_admin_schema_${suffix}`;
    schemas.push(schema);
    const principals = principalNames("role_admin");
    rolesToDrop.push(...Object.values(principals));
    try {
      await admin!.unsafe(`CREATE SCHEMA ${schema} AUTHORIZATION ${roleAdmin}`);
      for (const role of Object.values(principals)) {
        await roleAdminSql.unsafe(
          `CREATE ROLE ${role} LOGIN PASSWORD '${password}' INHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`,
        );
      }
      const scopedAdminUrl = withSearchPath(roleAdminUrl, schema);
      let provisioned: ProductionDatabaseRoles;
      try {
        provisioned = await bootstrapProductionDatabaseRoles(
          scopedAdminUrl,
          principals,
        );
      } catch (error) {
        throw new Error("non-superuser bootstrap failed", { cause: error });
      }
      capabilityRoles.push(provisioned);
      const authorityMembers = await admin!<
        {
          member_name: string;
          inherit_option: boolean;
          set_option: boolean;
        }[]
      >`
        SELECT member.rolname AS member_name, membership.inherit_option,
          membership.set_option
        FROM pg_auth_members AS membership
        JOIN pg_roles AS authority ON authority.oid = membership.roleid
        JOIN pg_roles AS member ON member.oid = membership.member
        WHERE authority.rolname = ${provisioned.authority}
      `;
      expect(authorityMembers).toHaveLength(1);
      expect(
        authorityMembers.every(
          (member) =>
            member.member_name === roleAdmin &&
            !member.inherit_option &&
            !member.set_option,
        ),
      ).toBe(true);
      const migratorUrl = asRoleUrl(
        withSearchPath(baseDatabaseUrl!, schema),
        principals.migrator,
      );
      const migratorSql = postgres(migratorUrl, { max: 1 });
      await expect(migratorSql<
        { current_user: string; current_schema: string; can_create: boolean }[]
      >`
        SELECT current_user, current_schema(),
          has_schema_privilege(current_user, ${schema}, 'USAGE, CREATE') AS can_create
      `).resolves.toEqual([
        {
          current_user: principals.migrator,
          current_schema: schema,
          can_create: true,
        },
      ]);
      await migratorSql.end();
      try {
        await runIngestionMigrations(migratorUrl);
        await runReconciliationMigrations(migratorUrl);
      } catch (error) {
        throw new Error("non-superuser migration failed", { cause: error });
      }
      await expect(runPlatformMigrations(migratorUrl)).resolves.toBeUndefined();

      const rotated = principalNames("role_admin_rotated");
      rolesToDrop.push(...Object.values(rotated));
      for (const role of Object.values(rotated)) {
        await roleAdminSql.unsafe(
          `CREATE ROLE ${role} LOGIN PASSWORD '${password}' INHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`,
        );
      }
      await expect(
        bootstrapProductionDatabaseRoles(scopedAdminUrl, rotated),
      ).resolves.toEqual(provisioned);

      const unmanaged = principalNames("role_admin_unmanaged");
      rolesToDrop.push(...Object.values(unmanaged));
      for (const role of Object.values(unmanaged)) {
        await admin!.unsafe(
          `CREATE ROLE ${role} LOGIN PASSWORD '${password}' INHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`,
        );
      }
      await expect(
        bootstrapProductionDatabaseRoles(scopedAdminUrl, unmanaged),
      ).rejects.toMatchObject({
        code: "production_role_bootstrap_requires_role_admin_option",
      });
      await expect(admin!`
        SELECT
          pg_has_role(${rotated.runtime}, ${provisioned.runtime}, 'MEMBER') AS old_member,
          pg_has_role(${unmanaged.runtime}, ${provisioned.runtime}, 'MEMBER') AS new_member
      `).resolves.toEqual([{ old_member: true, new_member: false }]);
    } finally {
      await roleAdminSql.end();
    }
  });

  it("bootstraps a legacy schema after migration 4011 and finalizes it once", async () => {
    const schema = await createSchema("upgrade");
    const principals = await createPrincipals("upgrade");
    const adminUrl = withSearchPath(baseDatabaseUrl!, schema);
    await runIngestionMigrations(adminUrl);
    await runReconciliationMigrations(adminUrl);
    const through4011 = [
      "4001_identity_organizations",
      "4002_tenant_scope_existing_data",
      "4003_merchants_customers_invoices",
      "4004_idempotency_and_audit",
      "4005_public_checkouts_and_rates",
      "4006_quotes_and_payment_attempts",
      "4007_hosted_reconciliation_and_projections",
      "4008_worker_jobs",
      "4009_payment_attempt_idempotency",
      "4010_merchant_operations",
      "4011_production_controls",
    ] as const;
    await runMigrationSet(
      adminUrl,
      await Promise.all(
        through4011.map(async (name) => ({
          name,
          sql: await readFile(
            new URL(`../migrations/${name}.sql`, import.meta.url),
            "utf8",
          ),
        })),
      ),
    );

    const provisioned = await bootstrapProductionDatabaseRoles(
      adminUrl,
      principals,
    );
    capabilityRoles.push(provisioned);
    await runPlatformMigrations(adminUrl);
    await runPlatformMigrations(adminUrl);

    await expect(admin!`
      SELECT pg_get_userbyid(class.relowner) AS owner_name
      FROM pg_class AS class
      WHERE class.relnamespace = ${schema}::regnamespace
        AND class.relname IN (
          'audit_events', 'organization_production_controls',
          'production_readiness_attestations', 'shadow_projection_decisions'
        )
      ORDER BY class.relname
    `).resolves.toEqual(
      Array.from({ length: 4 }, () => ({
        owner_name: provisioned.authority,
      })),
    );
  });

  it("rolls back membership rotation when bootstrap finalization fails", async () => {
    const schema = await createSchema("atomic");
    const initial = await createPrincipals("atomic_initial");
    const rotated = await createPrincipals("atomic_rotated");
    const adminUrl = withSearchPath(baseDatabaseUrl!, schema);
    const provisioned = await bootstrapProductionDatabaseRoles(
      adminUrl,
      initial,
    );
    capabilityRoles.push(provisioned);
    const trigger = `payops_fail_bootstrap_${suffix}`;
    const triggerFunction = `payops_fail_bootstrap_function_${suffix}`;
    await admin!.unsafe(`
      CREATE FUNCTION public.${triggerFunction}() RETURNS event_trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF current_query() LIKE '%${schema}%'
          AND current_query() LIKE '%payops_production_role_bootstrap_marker%'
        THEN
          RAISE EXCEPTION 'injected bootstrap failure';
        END IF;
      END $$
    `);
    await admin!.unsafe(`
      CREATE EVENT TRIGGER ${trigger} ON ddl_command_start
      WHEN TAG IN ('CREATE FUNCTION')
      EXECUTE FUNCTION public.${triggerFunction}()
    `);
    try {
      await expect(
        bootstrapProductionDatabaseRoles(adminUrl, rotated),
      ).rejects.toThrow("injected bootstrap failure");
    } finally {
      await admin!.unsafe(`DROP EVENT TRIGGER IF EXISTS ${trigger}`);
      await admin!.unsafe(`DROP FUNCTION public.${triggerFunction}()`);
    }
    await expect(admin!`
      SELECT
        pg_has_role(${initial.runtime}, ${provisioned.runtime}, 'MEMBER') AS old_member,
        pg_has_role(${rotated.runtime}, ${provisioned.runtime}, 'MEMBER') AS new_member
    `).resolves.toEqual([{ old_member: true, new_member: false }]);
  });
});

async function createPrincipals(
  label: string,
): Promise<ProductionDatabasePrincipals> {
  const principals = principalNames(label);
  rolesToDrop.push(...Object.values(principals));
  for (const role of Object.values(principals)) {
    await admin!.unsafe(
      `CREATE ROLE ${role} LOGIN PASSWORD '${password}' INHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`,
    );
  }
  return principals;
}

function principalNames(label: string): ProductionDatabasePrincipals {
  return {
    migrator: `payops_${label}_migrator_${suffix}`,
    runtime: `payops_${label}_runtime_${suffix}`,
    control: `payops_${label}_control_${suffix}`,
    readinessVerifier: `payops_${label}_verifier_${suffix}`,
    shadowProjector: `payops_${label}_projector_${suffix}`,
  };
}

async function createSchema(label: string): Promise<string> {
  const schema = `payops_${label}_${suffix}`;
  schemas.push(schema);
  await admin!.unsafe(`CREATE SCHEMA ${schema}`);
  return schema;
}

function registerRole(role: string): string {
  rolesToDrop.push(role);
  return role;
}

function withSearchPath(urlString: string, schema: string): string {
  const url = new URL(urlString);
  url.searchParams.set("options", `-csearch_path=${schema}`);
  return url.toString();
}

function asRoleUrl(urlString: string, role: string): string {
  const url = new URL(urlString);
  url.username = role;
  url.password = password;
  return url.toString();
}
