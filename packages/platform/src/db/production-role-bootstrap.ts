import { createHash } from "node:crypto";
import postgres from "postgres";

const roleNamePattern = /^[a-z_][a-z0-9_]{0,62}$/;

export interface ProductionDatabasePrincipals {
  readonly migrator: string;
  readonly runtime: string;
  readonly control: string;
  readonly readinessVerifier: string;
  readonly shadowProjector: string;
}

export interface ProductionDatabaseRoles {
  readonly authority: string;
  readonly migrator: string;
  readonly runtime: string;
  readonly control: string;
  readonly readinessVerifier: string;
  readonly shadowProjector: string;
}

export class ProductionRoleBootstrapError extends Error {
  public constructor(readonly code: string) {
    super("Production database role bootstrap failed");
    this.name = "ProductionRoleBootstrapError";
  }
}

export async function bootstrapProductionDatabaseRoles(
  databaseAdminUrl: string,
  principals: ProductionDatabasePrincipals,
): Promise<ProductionDatabaseRoles> {
  validatePrincipalNames(principals);
  const sql = postgres(databaseAdminUrl, {
    max: 1,
    onnotice: () => undefined,
  });
  try {
    const [context] = await sql<
      {
        database_oid: string;
        schema_name: string;
        bootstrap_role: string;
        is_superuser: boolean;
        can_create_roles: boolean;
      }[]
    >`
      SELECT database.oid::text AS database_oid, current_schema() AS schema_name,
        current_user AS bootstrap_role,
        role.rolsuper AS is_superuser,
        (role.rolsuper OR role.rolcreaterole) AS can_create_roles
      FROM pg_database AS database
      JOIN pg_roles AS role ON role.rolname = current_user
      WHERE database.datname = current_database()
    `;
    if (context === undefined || !context.can_create_roles) {
      throw new ProductionRoleBootstrapError(
        "production_role_bootstrap_requires_role_admin",
      );
    }
    const schemaName = context.schema_name;
    if (!roleNamePattern.test(schemaName)) {
      throw new ProductionRoleBootstrapError(
        "invalid_production_database_schema",
      );
    }
    const roles = roleNames(context.database_oid, schemaName);
    const lockKey = `payops:production-role-bootstrap:${context.database_oid}:${schemaName}`;
    await sql`SELECT pg_advisory_lock(hashtextextended(${lockKey}, 0))`;
    try {
      await sql.begin(async (transaction) => {
        await assertPrincipalsAreRestricted(transaction, principals);
        await assertSchemaOwnership(
          transaction,
          schemaName,
          context.bootstrap_role,
        );
        for (const role of Object.values(roles)) {
          await ensureCapabilityRole(transaction, role);
        }
        await assertRoleAdministration(
          transaction,
          context.bootstrap_role,
          context.is_superuser,
          [principals.migrator, ...Object.values(roles)],
        );
        await assertSafeRoleGraph(transaction, principals, roles);
        await assertNoEffectiveMembers(
          transaction,
          roles.authority,
          context.bootstrap_role,
        );
        await assertProtectedObjectState(
          transaction,
          schemaName,
          roles.authority,
        );
        await transaction.unsafe(
          `GRANT ${quoteIdentifier(principals.migrator)} TO ${quoteIdentifier(context.bootstrap_role)}`,
        );
        await transaction.unsafe(
          `GRANT USAGE ON SCHEMA ${quoteIdentifier(schemaName)} TO ${Object.values(
            roles,
          )
            .map(quoteIdentifier)
            .join(", ")}`,
        );
        await transaction.unsafe(
          `GRANT CREATE ON SCHEMA ${quoteIdentifier(schemaName)} TO ${quoteIdentifier(roles.authority)}, ${quoteIdentifier(roles.migrator)}`,
        );
        await installFinalizer(
          transaction,
          schemaName,
          roles,
          context.bootstrap_role,
        );
        await rotateMembership(
          transaction,
          roles.migrator,
          principals.migrator,
        );
        await rotateMembership(transaction, roles.runtime, principals.runtime);
        await rotateMembership(transaction, roles.control, principals.control);
        await rotateMembership(
          transaction,
          roles.readinessVerifier,
          principals.readinessVerifier,
        );
        await rotateMembership(
          transaction,
          roles.shadowProjector,
          principals.shadowProjector,
        );
        await installBootstrapMarker(
          transaction,
          schemaName,
          context.bootstrap_role,
          roles.migrator,
        );
      });
      return roles;
    } finally {
      await sql`SELECT pg_advisory_unlock(hashtextextended(${lockKey}, 0))`;
    }
  } finally {
    await sql.end();
  }
}

function roleNames(
  databaseOid: string,
  schemaName: string,
): ProductionDatabaseRoles {
  const scope = createHash("sha256")
    .update(`${databaseOid}:${schemaName}`, "utf8")
    .digest("hex")
    .slice(0, 12);
  const prefix = `payops_pc_${databaseOid}_${scope}`;
  return {
    authority: `${prefix}_authority`,
    migrator: `${prefix}_migrator`,
    runtime: `${prefix}_runtime`,
    control: `${prefix}_control`,
    readinessVerifier: `${prefix}_verifier`,
    shadowProjector: `${prefix}_projector`,
  };
}

function validatePrincipalNames(
  principals: ProductionDatabasePrincipals,
): void {
  const names = Object.values(principals);
  if (
    names.some((name) => !roleNamePattern.test(name)) ||
    new Set(names).size !== names.length
  ) {
    throw new ProductionRoleBootstrapError("invalid_production_principal");
  }
}

async function assertPrincipalsAreRestricted(
  sql: postgres.Sql,
  principals: ProductionDatabasePrincipals,
): Promise<void> {
  const names = Object.values(principals);
  const rows = await sql<
    {
      rolname: string;
      rolcanlogin: boolean;
      rolinherit: boolean;
      rolsuper: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolreplication: boolean;
      rolbypassrls: boolean;
    }[]
  >`
    SELECT rolname, rolcanlogin, rolinherit, rolsuper, rolcreatedb,
      rolcreaterole, rolreplication, rolbypassrls
    FROM pg_roles WHERE rolname = ANY(${names})
  `;
  if (
    rows.length !== names.length ||
    rows.some(
      (role) =>
        !role.rolcanlogin ||
        !role.rolinherit ||
        role.rolsuper ||
        role.rolcreatedb ||
        role.rolcreaterole ||
        role.rolreplication ||
        role.rolbypassrls,
    )
  ) {
    throw new ProductionRoleBootstrapError(
      "production_principal_must_be_restricted_login",
    );
  }
}

async function ensureCapabilityRole(
  sql: postgres.Sql,
  role: string,
): Promise<void> {
  const [existing] = await sql<
    {
      rolcanlogin: boolean;
      rolinherit: boolean;
      rolsuper: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolreplication: boolean;
      rolbypassrls: boolean;
    }[]
  >`
    SELECT rolcanlogin, rolinherit, rolsuper, rolcreatedb, rolcreaterole,
      rolreplication, rolbypassrls FROM pg_roles WHERE rolname = ${role}
  `;
  if (existing === undefined) {
    await sql.unsafe(
      `CREATE ROLE ${quoteIdentifier(role)} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
    );
    return;
  }
  if (
    existing.rolcanlogin ||
    existing.rolinherit ||
    existing.rolsuper ||
    existing.rolcreatedb ||
    existing.rolcreaterole ||
    existing.rolreplication ||
    existing.rolbypassrls
  ) {
    throw new ProductionRoleBootstrapError(
      "production_capability_role_is_not_restricted",
    );
  }
}

async function assertSchemaOwnership(
  sql: postgres.Sql,
  schemaName: string,
  bootstrapRole: string,
): Promise<void> {
  const [schema] = await sql<{ owner_name: string; can_create: boolean }[]>`
    SELECT pg_get_userbyid(namespace.nspowner) AS owner_name,
      has_schema_privilege(current_user, namespace.oid, 'USAGE, CREATE') AS can_create
    FROM pg_namespace AS namespace WHERE namespace.nspname = ${schemaName}
  `;
  if (
    schema === undefined ||
    schema.owner_name !== bootstrapRole ||
    !schema.can_create
  ) {
    throw new ProductionRoleBootstrapError(
      "production_role_bootstrap_requires_schema_owner",
    );
  }
}

async function assertRoleAdministration(
  sql: postgres.Sql,
  bootstrapRole: string,
  isSuperuser: boolean,
  managedRoles: readonly string[],
): Promise<void> {
  if (isSuperuser) return;
  const rows = await sql<{ role_name: string }[]>`
    SELECT DISTINCT managed.rolname AS role_name
    FROM pg_roles AS managed
    JOIN pg_auth_members AS membership ON membership.roleid = managed.oid
    JOIN pg_roles AS member ON member.oid = membership.member
    WHERE managed.rolname = ANY(${managedRoles})
      AND member.rolname = ${bootstrapRole}
      AND membership.admin_option
  `;
  if (rows.length !== new Set(managedRoles).size) {
    throw new ProductionRoleBootstrapError(
      "production_role_bootstrap_requires_role_admin_option",
    );
  }
}

async function assertSafeRoleGraph(
  sql: postgres.Sql,
  principals: ProductionDatabasePrincipals,
  roles: ProductionDatabaseRoles,
): Promise<void> {
  const expected = new Map<string, string>([
    [principals.migrator, roles.migrator],
    [principals.runtime, roles.runtime],
    [principals.control, roles.control],
    [principals.readinessVerifier, roles.readinessVerifier],
    [principals.shadowProjector, roles.shadowProjector],
  ]);
  const sources = [
    ...expected.keys(),
    roles.migrator,
    roles.runtime,
    roles.control,
    roles.readinessVerifier,
    roles.shadowProjector,
  ];
  const paths = await sql<{ source_name: string; target_name: string }[]>`
    WITH RECURSIVE membership_path AS (
      SELECT source.oid AS source_oid, membership.roleid AS target_oid,
        ARRAY[source.oid, membership.roleid] AS visited
      FROM pg_roles AS source
      JOIN pg_auth_members AS membership ON membership.member = source.oid
      WHERE source.rolname = ANY(${sources})
      UNION ALL
      SELECT path.source_oid, membership.roleid,
        path.visited || membership.roleid
      FROM membership_path AS path
      JOIN pg_auth_members AS membership ON membership.member = path.target_oid
      WHERE NOT membership.roleid = ANY(path.visited)
    )
    SELECT source.rolname AS source_name, target.rolname AS target_name
    FROM membership_path AS path
    JOIN pg_roles AS source ON source.oid = path.source_oid
    JOIN pg_roles AS target ON target.oid = path.target_oid
  `;
  if (
    paths.some(
      ({ source_name, target_name }) =>
        expected.get(source_name) !== target_name,
    )
  ) {
    throw new ProductionRoleBootstrapError(
      "production_principal_has_unsafe_role_path",
    );
  }
}

async function assertProtectedObjectState(
  sql: postgres.Sql,
  schemaName: string,
  authorityRole: string,
): Promise<void> {
  const protectedTables = [
    "organization_production_controls",
    "shadow_projection_decisions",
    "production_readiness_attestations",
    "audit_events",
    "operational_measurements",
    "operational_incidents",
    "operational_incident_events",
    "operational_health_signals",
  ];
  const tables = await sql<{ object_name: string; owner_name: string }[]>`
    SELECT class.relname AS object_name,
      pg_get_userbyid(class.relowner) AS owner_name
    FROM pg_class AS class
    JOIN pg_namespace AS namespace ON namespace.oid = class.relnamespace
    WHERE namespace.nspname = ${schemaName}
      AND class.relname = ANY(${protectedTables})
  `;
  const migrationTable = quoteIdentifier("payops_schema_migrations");
  const [ledger] = await sql<{ exists: boolean }[]>`
    SELECT to_regclass(${`${schemaName}.payops_schema_migrations`}) IS NOT NULL AS exists
  `;
  const [migrations] = ledger?.exists
    ? await sql.unsafe<
        {
          authority_applied: boolean;
          review_hardening_applied: boolean;
          operational_health_applied: boolean;
        }[]
      >(`
        SELECT
          bool_or(name = '4012_production_control_authority') AS authority_applied,
          bool_or(name = '4013_production_control_review_hardening') AS review_hardening_applied,
          bool_or(name = '4015_operational_health') AS operational_health_applied
        FROM ${quoteIdentifier(schemaName)}.${migrationTable}
      `)
    : [
        {
          authority_applied: false,
          review_hardening_applied: false,
          operational_health_applied: false,
        },
      ];
  if (!migrations?.authority_applied) {
    if (
      tables.some(
        ({ object_name }) =>
          object_name === "production_readiness_attestations",
      )
    ) {
      throw new ProductionRoleBootstrapError(
        "production_control_object_boundary_invalid",
      );
    }
    return;
  }
  const authorityFunctions = [
    "payops_guard_production_control",
    "payops_guard_shadow_projection_decision",
    "payops_guard_production_readiness_attestation",
    "payops_create_production_control_for_organization",
    "payops_lock_production_activation_mode",
    "payops_attest_production_readiness",
    "payops_request_production_promotion",
    "payops_record_shadow_projection_decision",
  ];
  const reviewFunctions = migrations.review_hardening_applied
    ? [
        ...authorityFunctions,
        "payops_guard_reserved_audit_event",
        "payops_immutable_audit_event",
      ]
    : authorityFunctions;
  const healthFunctions = [
    "payops_guard_operational_health_record",
    "payops_record_operational_measurement",
    "payops_observe_operational_incident",
    "payops_acknowledge_operational_incident",
    "payops_resolve_operational_incident",
    "payops_operational_health_clear_for_promotion",
    "payops_guard_operational_health_promotion",
    "payops_process_operational_health_signals",
    "payops_enqueue_scheduled_operational_health_signals",
    "payops_enqueue_rpc_consensus_health_signal",
    "payops_enqueue_webhook_health_signal",
    "payops_enqueue_ledger_health_signal",
  ];
  const protectedFunctions = migrations.operational_health_applied
    ? [...reviewFunctions, ...healthFunctions]
    : reviewFunctions;
  const controlTables = migrations.review_hardening_applied
    ? protectedTables.slice(0, 4)
    : protectedTables.slice(0, 3);
  const expectedTables = migrations.operational_health_applied
    ? [...controlTables, ...protectedTables.slice(4)]
    : controlTables;
  const functions = await sql<{ object_name: string; owner_name: string }[]>`
    SELECT procedure.proname AS object_name,
      pg_get_userbyid(procedure.proowner) AS owner_name
    FROM pg_proc AS procedure
    JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
    WHERE namespace.nspname = ${schemaName}
      AND procedure.proname = ANY(${protectedFunctions})
  `;
  if (
    tables.filter(({ object_name }) => expectedTables.includes(object_name))
      .length !== expectedTables.length ||
    functions.length !== protectedFunctions.length ||
    [
      ...tables.filter(({ object_name }) =>
        expectedTables.includes(object_name),
      ),
      ...functions,
    ].some(({ owner_name }) => owner_name !== authorityRole)
  ) {
    throw new ProductionRoleBootstrapError(
      "production_control_object_boundary_invalid",
    );
  }
}

async function rotateMembership(
  sql: postgres.Sql,
  capabilityRole: string,
  principal: string,
): Promise<void> {
  const members = await sql<{ member_name: string }[]>`
    SELECT member.rolname AS member_name
    FROM pg_auth_members AS membership
    JOIN pg_roles AS capability ON capability.oid = membership.roleid
    JOIN pg_roles AS member ON member.oid = membership.member
    WHERE capability.rolname = ${capabilityRole}
  `;
  for (const member of members) {
    await sql.unsafe(
      `REVOKE ${quoteIdentifier(capabilityRole)} FROM ${quoteIdentifier(member.member_name)}`,
    );
  }
  await sql.unsafe(
    `GRANT ${quoteIdentifier(capabilityRole)} TO ${quoteIdentifier(principal)}`,
  );
}

async function assertNoEffectiveMembers(
  sql: postgres.Sql,
  role: string,
  bootstrapRole: string,
): Promise<void> {
  const members = await sql<
    {
      member_name: string;
      admin_option: boolean;
      inherit_option: boolean;
      set_option: boolean;
    }[]
  >`
    SELECT member.rolname AS member_name, membership.admin_option,
      membership.inherit_option, membership.set_option
    FROM pg_auth_members AS membership
    JOIN pg_roles AS capability ON capability.oid = membership.roleid
    JOIN pg_roles AS member ON member.oid = membership.member
    WHERE capability.rolname = ${role}
  `;
  if (
    members.some(
      (member) =>
        member.member_name !== bootstrapRole ||
        !member.admin_option ||
        member.inherit_option ||
        member.set_option,
    )
  ) {
    throw new ProductionRoleBootstrapError(
      "production_authority_role_has_effective_members",
    );
  }
}

async function installFinalizer(
  sql: postgres.Sql,
  schemaName: string,
  roles: ProductionDatabaseRoles,
  bootstrapRole: string,
): Promise<void> {
  const schema = quoteIdentifier(schemaName);
  const authority = quoteIdentifier(roles.authority);
  const migrator = quoteIdentifier(roles.migrator);
  const runtime = quoteIdentifier(roles.runtime);
  const control = quoteIdentifier(roles.control);
  const verifier = quoteIdentifier(roles.readinessVerifier);
  const projector = quoteIdentifier(roles.shadowProjector);
  const bootstrap = quoteIdentifier(bootstrapRole);
  const [existing] = await sql<{ owner_name: string; routine_kind: string }[]>`
    SELECT pg_get_userbyid(procedure.proowner) AS owner_name,
      procedure.prokind AS routine_kind
    FROM pg_proc AS procedure
    JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
    WHERE namespace.nspname = ${schemaName}
      AND procedure.proname = 'payops_finalize_production_control_authority'
      AND procedure.pronargs = 0
  `;
  if (existing !== undefined) {
    if (
      existing.owner_name !== bootstrapRole ||
      existing.routine_kind !== "f"
    ) {
      throw new ProductionRoleBootstrapError(
        "production_control_object_boundary_invalid",
      );
    }
  }
  await sql.unsafe(`
    CREATE OR REPLACE FUNCTION ${schema}.payops_finalize_production_control_authority()
    RETURNS void
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, ${schema}, pg_temp
    AS $bootstrap$
    BEGIN
      GRANT ${authority} TO ${bootstrap};
      IF SESSION_USER IS DISTINCT FROM CURRENT_USER THEN
        EXECUTE pg_catalog.format(
          'GRANT ${roles.authority} TO %I', SESSION_USER
        );
      END IF;
      LOCK TABLE ${schema}.audit_events IN ACCESS EXCLUSIVE MODE;
      LOCK TABLE ${schema}.organization_production_controls,
        ${schema}.production_readiness_attestations IN ACCESS EXCLUSIVE MODE;

      IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_trigger AS audit_trigger
        JOIN pg_catalog.pg_proc AS trigger_function
          ON trigger_function.oid = audit_trigger.tgfoid
        WHERE audit_trigger.tgrelid = '${schemaName}.audit_events'::regclass
          AND NOT audit_trigger.tgisinternal
          AND NOT (
            audit_trigger.tgname = 'audit_events_immutable'
            AND audit_trigger.tgtype = 27
            AND audit_trigger.tgenabled = 'O'
            AND audit_trigger.tgnargs = 0
            AND audit_trigger.tgqual IS NULL
            AND audit_trigger.tgattr::text = ''
            AND trigger_function.pronamespace = '${schemaName}'::regnamespace
            AND trigger_function.proname = 'payops_immutable_audit_event'
          )
          AND NOT (
            audit_trigger.tgname = 'audit_events_reserved_production_control_guard'
            AND audit_trigger.tgtype = 7
            AND audit_trigger.tgenabled = 'O'
            AND audit_trigger.tgnargs = 0
            AND audit_trigger.tgqual IS NULL
            AND audit_trigger.tgattr::text = ''
            AND trigger_function.pronamespace = '${schemaName}'::regnamespace
            AND trigger_function.proname = 'payops_guard_reserved_audit_event'
          )
      ) OR NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_trigger AS audit_trigger
        JOIN pg_catalog.pg_proc AS trigger_function
          ON trigger_function.oid = audit_trigger.tgfoid
        WHERE audit_trigger.tgrelid = '${schemaName}.audit_events'::regclass
          AND NOT audit_trigger.tgisinternal
          AND audit_trigger.tgname = 'audit_events_immutable'
          AND audit_trigger.tgtype = 27
          AND audit_trigger.tgenabled = 'O'
          AND audit_trigger.tgnargs = 0
          AND audit_trigger.tgqual IS NULL
          AND audit_trigger.tgattr::text = ''
          AND trigger_function.pronamespace = '${schemaName}'::regnamespace
          AND trigger_function.proname = 'payops_immutable_audit_event'
      ) THEN
        RAISE EXCEPTION 'unexpected or invalid audit_events trigger; inspect and remove it before production role bootstrap'
          USING ERRCODE = '55000';
      END IF;

      EXECUTE $audit_definition$
        CREATE OR REPLACE FUNCTION ${schema}.payops_immutable_audit_event()
        RETURNS trigger
        LANGUAGE plpgsql
        SET search_path = pg_catalog, pg_temp
        AS $audit_function$
        BEGIN
          RAISE EXCEPTION 'audit events are append-only'
            USING ERRCODE = '23514';
        END
        $audit_function$
      $audit_definition$;
      EXECUTE $audit_definition$
        CREATE OR REPLACE FUNCTION ${schema}.payops_guard_reserved_audit_event()
        RETURNS trigger
        LANGUAGE plpgsql
        SET search_path = pg_catalog, pg_temp
        AS $audit_function$
        DECLARE
          production_authority name;
        BEGIN
          IF NEW.action LIKE 'production_control.%' THEN
            SELECT pg_catalog.pg_get_userbyid(class.relowner)
            INTO production_authority
            FROM pg_catalog.pg_class AS class
            JOIN pg_catalog.pg_namespace AS namespace
              ON namespace.oid = class.relnamespace
            WHERE namespace.nspname = TG_TABLE_SCHEMA
              AND class.relname = 'organization_production_controls';
            IF CURRENT_USER IS DISTINCT FROM production_authority THEN
              RAISE EXCEPTION 'production control audit events require the privileged workflow'
                USING ERRCODE = '23514';
            END IF;
          END IF;
          RETURN NEW;
        END
        $audit_function$
      $audit_definition$;
      DROP TRIGGER IF EXISTS audit_events_reserved_production_control_guard
        ON ${schema}.audit_events;
      CREATE TRIGGER audit_events_reserved_production_control_guard
        BEFORE INSERT ON ${schema}.audit_events
        FOR EACH ROW EXECUTE FUNCTION ${schema}.payops_guard_reserved_audit_event();

      GRANT USAGE ON SCHEMA ${schema} TO ${authority}, ${migrator}, ${runtime}, ${control}, ${verifier}, ${projector};
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${runtime};
      GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA ${schema} TO ${runtime};
      IF to_regclass('${schemaName}.api_idempotency_records') IS NOT NULL THEN
        REVOKE ALL ON ${schema}.api_idempotency_records FROM ${control};
        GRANT SELECT ON ${schema}.api_idempotency_records TO ${control};
        GRANT UPDATE (
          state, response_status, response_content_type, response_body,
          completed_at, updated_at
        ) ON ${schema}.api_idempotency_records TO ${control};
      END IF;
      IF to_regclass('${schemaName}.worker_job_states') IS NOT NULL THEN
        REVOKE INSERT, DELETE ON ${schema}.worker_job_states FROM ${runtime};
        GRANT SELECT, UPDATE ON ${schema}.worker_job_states TO ${runtime};
      END IF;
      IF to_regclass('${schemaName}.worker_instances') IS NOT NULL THEN
        GRANT SELECT ON ${schema}.watch_targets, ${schema}.rpc_provider_roles,
          ${schema}.rpc_providers, ${schema}.worker_instances,
          ${schema}.worker_job_states TO ${verifier};
        GRANT SELECT ON ${schema}.rpc_providers TO ${authority};
      END IF;

      IF to_regprocedure(
        '${schemaName}.payops_attest_production_readiness_4013(uuid,integer,boolean,boolean,boolean,boolean,timestamptz,timestamptz)'
      ) IS NOT NULL THEN
        ALTER FUNCTION ${schema}.payops_attest_production_readiness(uuid, integer, boolean, boolean, boolean, boolean, timestamptz, timestamptz)
          RENAME TO payops_attest_production_readiness_4012;
        ALTER FUNCTION ${schema}.payops_attest_production_readiness_4013(uuid, integer, boolean, boolean, boolean, boolean, timestamptz, timestamptz)
          RENAME TO payops_attest_production_readiness;
        DROP FUNCTION ${schema}.payops_attest_production_readiness_4012(uuid, integer, boolean, boolean, boolean, boolean, timestamptz, timestamptz);
      END IF;

      ALTER TABLE ${schema}.organization_production_controls OWNER TO ${authority};
      ALTER TABLE ${schema}.shadow_projection_decisions OWNER TO ${authority};
      ALTER TABLE ${schema}.production_readiness_attestations OWNER TO ${authority};

      ALTER FUNCTION ${schema}.payops_guard_production_control() OWNER TO ${authority};
      ALTER FUNCTION ${schema}.payops_guard_shadow_projection_decision() OWNER TO ${authority};
      ALTER FUNCTION ${schema}.payops_guard_production_readiness_attestation() OWNER TO ${authority};
      ALTER FUNCTION ${schema}.payops_create_production_control_for_organization() OWNER TO ${authority};
      ALTER FUNCTION ${schema}.payops_lock_production_activation_mode(uuid) OWNER TO ${authority};
      ALTER FUNCTION ${schema}.payops_attest_production_readiness(uuid, integer, boolean, boolean, boolean, boolean, timestamptz, timestamptz) OWNER TO ${authority};
      ALTER FUNCTION ${schema}.payops_request_production_promotion(uuid, integer, timestamptz, text, text, uuid, uuid) OWNER TO ${authority};
      ALTER FUNCTION ${schema}.payops_record_shadow_projection_decision(uuid, uuid, bigint, text, uuid, text, text, uuid, text, text, text, text, text, timestamptz) OWNER TO ${authority};

      REVOKE ALL ON ${schema}.organization_production_controls,
        ${schema}.shadow_projection_decisions,
        ${schema}.production_readiness_attestations FROM PUBLIC, ${runtime}, ${migrator}, ${control}, ${verifier}, ${projector};
      REVOKE ALL ON ${schema}.audit_events FROM PUBLIC, ${runtime}, ${migrator}, ${control}, ${verifier}, ${projector};
      GRANT SELECT ON ${schema}.organization_production_controls,
        ${schema}.shadow_projection_decisions TO ${runtime};

      ALTER TABLE ${schema}.audit_events OWNER TO ${authority};
      ALTER FUNCTION ${schema}.payops_guard_reserved_audit_event() OWNER TO ${authority};
      ALTER FUNCTION ${schema}.payops_immutable_audit_event() OWNER TO ${authority};
      REVOKE ALL ON ${schema}.audit_events FROM PUBLIC, ${runtime}, ${migrator}, ${control}, ${verifier}, ${projector};
      GRANT SELECT, INSERT ON ${schema}.audit_events TO ${runtime};

      REVOKE ALL ON FUNCTION ${schema}.payops_attest_production_readiness(uuid, integer, boolean, boolean, boolean, boolean, timestamptz, timestamptz) FROM PUBLIC, ${runtime}, ${migrator}, ${control}, ${verifier}, ${projector};
      REVOKE ALL ON FUNCTION ${schema}.payops_lock_production_activation_mode(uuid) FROM PUBLIC, ${runtime}, ${migrator}, ${control}, ${verifier}, ${projector};
      REVOKE ALL ON FUNCTION ${schema}.payops_request_production_promotion(uuid, integer, timestamptz, text, text, uuid, uuid) FROM PUBLIC, ${runtime}, ${migrator}, ${control}, ${verifier}, ${projector};
      REVOKE ALL ON FUNCTION ${schema}.payops_record_shadow_projection_decision(uuid, uuid, bigint, text, uuid, text, text, uuid, text, text, text, text, text, timestamptz) FROM PUBLIC, ${runtime}, ${migrator}, ${control}, ${verifier}, ${projector};
      GRANT EXECUTE ON FUNCTION ${schema}.payops_attest_production_readiness(uuid, integer, boolean, boolean, boolean, boolean, timestamptz, timestamptz) TO ${verifier};
      GRANT EXECUTE ON FUNCTION ${schema}.payops_lock_production_activation_mode(uuid) TO ${runtime};
      GRANT EXECUTE ON FUNCTION ${schema}.payops_request_production_promotion(uuid, integer, timestamptz, text, text, uuid, uuid) TO ${control};
      GRANT EXECUTE ON FUNCTION ${schema}.payops_record_shadow_projection_decision(uuid, uuid, bigint, text, uuid, text, text, uuid, text, text, text, text, text, timestamptz) TO ${projector};

      IF to_regclass('${schemaName}.operational_incidents') IS NOT NULL THEN
        IF to_regprocedure(
          '${schemaName}.payops_request_production_promotion_4015(uuid,integer,timestamptz,text,text,uuid,uuid)'
        ) IS NOT NULL THEN
          ALTER FUNCTION ${schema}.payops_request_production_promotion(uuid, integer, timestamptz, text, text, uuid, uuid)
            RENAME TO payops_request_production_promotion_4012;
          ALTER FUNCTION ${schema}.payops_request_production_promotion_4015(uuid, integer, timestamptz, text, text, uuid, uuid)
            RENAME TO payops_request_production_promotion;
          DROP FUNCTION ${schema}.payops_request_production_promotion_4012(uuid, integer, timestamptz, text, text, uuid, uuid);
        END IF;
        ALTER FUNCTION ${schema}.payops_request_production_promotion(uuid, integer, timestamptz, text, text, uuid, uuid) OWNER TO ${authority};
        REVOKE ALL ON FUNCTION ${schema}.payops_request_production_promotion(uuid, integer, timestamptz, text, text, uuid, uuid) FROM PUBLIC, ${runtime}, ${migrator}, ${control}, ${verifier}, ${projector};
        GRANT EXECUTE ON FUNCTION ${schema}.payops_request_production_promotion(uuid, integer, timestamptz, text, text, uuid, uuid) TO ${control};

        ALTER TABLE ${schema}.operational_measurements OWNER TO ${authority};
        ALTER TABLE ${schema}.operational_incidents OWNER TO ${authority};
        ALTER TABLE ${schema}.operational_incident_events OWNER TO ${authority};
        ALTER TABLE ${schema}.operational_health_signals OWNER TO ${authority};

        ALTER FUNCTION ${schema}.payops_guard_operational_health_record() OWNER TO ${authority};
        ALTER FUNCTION ${schema}.payops_record_operational_measurement(uuid, text, numeric, timestamptz) OWNER TO ${authority};
        ALTER FUNCTION ${schema}.payops_observe_operational_incident(uuid, text, text, text, text, timestamptz) OWNER TO ${authority};
        ALTER FUNCTION ${schema}.payops_acknowledge_operational_incident(uuid, uuid, integer, text, timestamptz) OWNER TO ${authority};
        ALTER FUNCTION ${schema}.payops_resolve_operational_incident(uuid, uuid, integer, text, text, timestamptz) OWNER TO ${authority};
        ALTER FUNCTION ${schema}.payops_operational_health_clear_for_promotion(uuid) OWNER TO ${authority};
        ALTER FUNCTION ${schema}.payops_guard_operational_health_promotion() OWNER TO ${authority};
        ALTER FUNCTION ${schema}.payops_process_operational_health_signals(uuid, integer, timestamptz) OWNER TO ${authority};
        ALTER FUNCTION ${schema}.payops_enqueue_scheduled_operational_health_signals(uuid, timestamptz, text, text, text, text, text, text, text, text) OWNER TO ${authority};
        ALTER FUNCTION ${schema}.payops_enqueue_rpc_consensus_health_signal() OWNER TO ${authority};
        ALTER FUNCTION ${schema}.payops_enqueue_webhook_health_signal() OWNER TO ${authority};
        ALTER FUNCTION ${schema}.payops_enqueue_ledger_health_signal() OWNER TO ${authority};

        REVOKE ALL ON ${schema}.operational_measurements,
          ${schema}.operational_incidents,
          ${schema}.operational_incident_events,
          ${schema}.operational_health_signals
          FROM PUBLIC, ${runtime}, ${migrator}, ${control}, ${verifier}, ${projector};
        GRANT SELECT ON ${schema}.operational_measurements,
          ${schema}.operational_incidents,
          ${schema}.operational_incident_events TO ${runtime};
        REVOKE ALL ON FUNCTION ${schema}.payops_record_operational_measurement(uuid, text, numeric, timestamptz) FROM PUBLIC, ${runtime}, ${migrator}, ${control}, ${verifier}, ${projector};
        REVOKE ALL ON FUNCTION ${schema}.payops_observe_operational_incident(uuid, text, text, text, text, timestamptz) FROM PUBLIC, ${runtime}, ${migrator}, ${control}, ${verifier}, ${projector};
        REVOKE ALL ON FUNCTION ${schema}.payops_acknowledge_operational_incident(uuid, uuid, integer, text, timestamptz) FROM PUBLIC, ${runtime}, ${migrator}, ${control}, ${verifier}, ${projector};
        REVOKE ALL ON FUNCTION ${schema}.payops_resolve_operational_incident(uuid, uuid, integer, text, text, timestamptz) FROM PUBLIC, ${runtime}, ${migrator}, ${control}, ${verifier}, ${projector};
        REVOKE ALL ON FUNCTION ${schema}.payops_operational_health_clear_for_promotion(uuid) FROM PUBLIC, ${runtime}, ${migrator}, ${control}, ${verifier}, ${projector};
        REVOKE ALL ON FUNCTION ${schema}.payops_guard_operational_health_promotion() FROM PUBLIC, ${runtime}, ${migrator}, ${control}, ${verifier}, ${projector};
        REVOKE ALL ON FUNCTION ${schema}.payops_process_operational_health_signals(uuid, integer, timestamptz) FROM PUBLIC, ${runtime}, ${migrator}, ${control}, ${verifier}, ${projector};
        REVOKE ALL ON FUNCTION ${schema}.payops_enqueue_scheduled_operational_health_signals(uuid, timestamptz, text, text, text, text, text, text, text, text) FROM PUBLIC, ${runtime}, ${migrator}, ${control}, ${verifier}, ${projector};
        DROP TRIGGER IF EXISTS organization_production_controls_health_guard
          ON ${schema}.organization_production_controls;
        CREATE TRIGGER organization_production_controls_health_guard
          BEFORE UPDATE ON ${schema}.organization_production_controls
          FOR EACH ROW EXECUTE FUNCTION ${schema}.payops_guard_operational_health_promotion();
        GRANT EXECUTE ON FUNCTION ${schema}.payops_record_operational_measurement(uuid, text, numeric, timestamptz),
          ${schema}.payops_observe_operational_incident(uuid, text, text, text, text, timestamptz),
          ${schema}.payops_acknowledge_operational_incident(uuid, uuid, integer, text, timestamptz),
          ${schema}.payops_resolve_operational_incident(uuid, uuid, integer, text, text, timestamptz),
          ${schema}.payops_operational_health_clear_for_promotion(uuid),
          ${schema}.payops_process_operational_health_signals(uuid, integer, timestamptz),
          ${schema}.payops_enqueue_scheduled_operational_health_signals(uuid, timestamptz, text, text, text, text, text, text, text, text)
          TO ${runtime};

        GRANT SELECT ON ${schema}.rpc_consensus_checks,
          ${schema}.rpc_provider_roles,
          ${schema}.webhook_delivery_attempts, ${schema}.webhook_deliveries,
          ${schema}.webhook_events, ${schema}.ledger_reconciliations,
          ${schema}.worker_instances, ${schema}.worker_job_states
          TO ${authority};
      END IF;

      GRANT INSERT ON ${schema}.audit_events TO ${authority};
      GRANT SELECT ON ${schema}.chain_events, ${schema}.normalized_transfers,
        ${schema}.event_references, ${schema}.hosted_payment_expectations,
        ${schema}.payment_attempts TO ${authority};
      IF SESSION_USER IS DISTINCT FROM CURRENT_USER THEN
        EXECUTE pg_catalog.format(
          'REVOKE ${roles.authority} FROM %I GRANTED BY CURRENT_USER',
          SESSION_USER
        );
      END IF;
      REVOKE ${authority} FROM ${bootstrap};
    END
    $bootstrap$;
    REVOKE ALL ON FUNCTION ${schema}.payops_finalize_production_control_authority() FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION ${schema}.payops_finalize_production_control_authority() TO ${migrator};
  `);
}

async function installBootstrapMarker(
  sql: postgres.Sql,
  schemaName: string,
  bootstrapRole: string,
  migratorRole: string,
): Promise<void> {
  const schema = quoteIdentifier(schemaName);
  const owner = quoteIdentifier(bootstrapRole);
  const migrator = quoteIdentifier(migratorRole);
  const [existing] = await sql<{ owner_name: string; routine_kind: string }[]>`
    SELECT pg_get_userbyid(procedure.proowner) AS owner_name,
      procedure.prokind AS routine_kind
    FROM pg_proc AS procedure
    JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
    WHERE namespace.nspname = ${schemaName}
      AND procedure.proname = 'payops_production_role_bootstrap_marker'
      AND procedure.pronargs = 0
  `;
  if (
    existing !== undefined &&
    (existing.owner_name !== bootstrapRole || existing.routine_kind !== "f")
  ) {
    await sql.unsafe(
      `DROP ROUTINE ${schema}.payops_production_role_bootstrap_marker()`,
    );
  }
  await sql.unsafe(`
    CREATE OR REPLACE FUNCTION ${schema}.payops_production_role_bootstrap_marker()
    RETURNS text LANGUAGE sql IMMUTABLE
    SET search_path = pg_catalog, pg_temp
    AS $$ SELECT '4013'::text $$;
    ALTER FUNCTION ${schema}.payops_production_role_bootstrap_marker() OWNER TO ${owner};
    REVOKE ALL ON FUNCTION ${schema}.payops_production_role_bootstrap_marker() FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION ${schema}.payops_production_role_bootstrap_marker() TO ${migrator};
  `);
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
