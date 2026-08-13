DO $migration$
DECLARE
  marker_oid oid;
  marker_valid boolean;
  finalizer_valid boolean;
  bootstrap_version text;
BEGIN
  marker_oid := pg_catalog.to_regprocedure(pg_catalog.format(
    '%I.payops_production_role_bootstrap_marker()', current_schema()
  ));
  SELECT procedure.proowner = namespace.nspowner
      AND procedure.prokind = 'f'
      AND procedure.prorettype = 'pg_catalog.text'::pg_catalog.regtype
      AND language.lanname = 'sql'
      AND procedure.provolatile = 'i'
      AND NOT procedure.prosecdef
  INTO marker_valid
  FROM pg_catalog.pg_proc AS procedure
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = procedure.pronamespace
  JOIN pg_catalog.pg_language AS language
    ON language.oid = procedure.prolang
  WHERE procedure.oid = marker_oid;

  SELECT finalizer.proowner = namespace.nspowner
      AND finalizer.prokind = 'f'
      AND finalizer.prorettype = 'pg_catalog.void'::pg_catalog.regtype
      AND language.lanname = 'plpgsql'
      AND finalizer.prosecdef
  INTO finalizer_valid
  FROM pg_catalog.pg_proc AS finalizer
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = finalizer.pronamespace
  JOIN pg_catalog.pg_language AS language
    ON language.oid = finalizer.prolang
  WHERE finalizer.oid = pg_catalog.to_regprocedure(pg_catalog.format(
    '%I.payops_finalize_production_control_authority()', current_schema()
  ));

  IF marker_valid IS NOT TRUE OR finalizer_valid IS NOT TRUE THEN
    RAISE EXCEPTION 'production role bootstrap must be upgraded before migration 4013'
      USING ERRCODE = '55000';
  END IF;
  EXECUTE pg_catalog.format(
    'SELECT %I.payops_production_role_bootstrap_marker()', current_schema()
  ) INTO bootstrap_version;
  IF bootstrap_version IS DISTINCT FROM '4013' THEN
    RAISE EXCEPTION 'production role bootstrap must be upgraded before migration 4013'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

DO $migration$
DECLARE
  schema_name name := current_schema();
BEGIN
  EXECUTE pg_catalog.format(
    $definition$
      CREATE OR REPLACE FUNCTION %1$I.payops_attest_production_readiness_4013(
        p_organization_id uuid,
        p_control_version integer,
        p_complete_watch_coverage boolean,
        p_fresh_worker_heartbeat boolean,
        p_two_active_production_rpc_roles boolean,
        p_no_open_critical_incident boolean,
        p_evaluated_at timestamptz,
        p_expires_at timestamptz
      ) RETURNS uuid
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, %1$I, pg_temp
      SET row_security = on
      AS $function$
      DECLARE
        attestation_id uuid := gen_random_uuid();
      BEGIN
        IF p_organization_id IS DISTINCT FROM %1$I.payops_current_organization_id() THEN
          RAISE EXCEPTION 'organization scope mismatch' USING ERRCODE = '42501';
        END IF;
        IF p_evaluated_at < clock_timestamp() - interval '2 seconds'
          OR p_evaluated_at > transaction_timestamp() + interval '1 minute'
          OR p_expires_at <= transaction_timestamp()
          OR p_expires_at > p_evaluated_at + interval '5 minutes'
        THEN
          RAISE EXCEPTION 'invalid readiness attestation window' USING ERRCODE = '22023';
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM %1$I.organization_production_controls
          WHERE organization_id = p_organization_id
            AND activation_mode = 'shadow' AND version = p_control_version
        ) THEN
          RAISE EXCEPTION 'production control version conflict' USING ERRCODE = '40001';
        END IF;
        INSERT INTO %1$I.production_readiness_attestations (
          id, organization_id, control_version, complete_watch_coverage,
          fresh_worker_heartbeat, two_active_production_rpc_roles,
          no_open_critical_incident, evaluated_at, expires_at
        ) VALUES (
          attestation_id, p_organization_id, p_control_version,
          p_complete_watch_coverage, p_fresh_worker_heartbeat,
          p_two_active_production_rpc_roles, p_no_open_critical_incident,
          p_evaluated_at, p_expires_at
        );
        RETURN attestation_id;
      END
      $function$
    $definition$,
    schema_name
  );
END
$migration$;

SELECT payops_finalize_production_control_authority();
