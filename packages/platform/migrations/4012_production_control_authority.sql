CREATE TABLE production_readiness_attestations (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  control_version integer NOT NULL CHECK (control_version > 0),
  complete_watch_coverage boolean NOT NULL,
  fresh_worker_heartbeat boolean NOT NULL,
  two_active_production_rpc_roles boolean NOT NULL,
  no_open_critical_incident boolean NOT NULL,
  evaluated_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (expires_at > evaluated_at),
  CHECK (expires_at <= evaluated_at + interval '5 minutes')
);

CREATE INDEX production_readiness_attestations_lookup
  ON production_readiness_attestations (
    organization_id, control_version, evaluated_at DESC, id DESC
  );

ALTER TABLE production_readiness_attestations ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_readiness_attestations FORCE ROW LEVEL SECURITY;
CREATE POLICY production_readiness_attestations_tenant_policy
  ON production_readiness_attestations
  USING (organization_id = payops_current_organization_id())
  WITH CHECK (organization_id = payops_current_organization_id());

CREATE OR REPLACE FUNCTION payops_guard_production_readiness_attestation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  table_owner name;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(relowner)
  INTO table_owner
  FROM pg_catalog.pg_class
  WHERE oid = TG_RELID;
  IF TG_OP <> 'INSERT' OR CURRENT_USER <> table_owner THEN
    RAISE EXCEPTION 'production readiness attestations are immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER production_readiness_attestations_guard
BEFORE INSERT OR UPDATE OR DELETE ON production_readiness_attestations
FOR EACH ROW EXECUTE FUNCTION payops_guard_production_readiness_attestation();

DROP FUNCTION payops_ensure_production_control(uuid);
DROP FUNCTION payops_promote_production_control(
  uuid, integer, timestamptz, text
);
DROP FUNCTION payops_record_shadow_projection_decision(
  uuid, uuid, bigint, text, uuid, text, uuid, text, text, text, text,
  text, timestamptz
);

DO $migration$
DECLARE
  schema_name name := current_schema();
BEGIN
  EXECUTE pg_catalog.format(
    $definition$
      CREATE OR REPLACE FUNCTION %1$I.payops_create_production_control_for_organization()
      RETURNS trigger
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, %1$I, pg_temp
      SET row_security = on
      AS $function$
      DECLARE
        prior_organization_id text := current_setting(
          'payops.organization_id', true
        );
      BEGIN
        PERFORM set_config('payops.organization_id', NEW.id::text, true);
        BEGIN
          INSERT INTO %1$I.organization_production_controls (organization_id)
          VALUES (NEW.id);
        EXCEPTION WHEN OTHERS THEN
          PERFORM set_config(
            'payops.organization_id', COALESCE(prior_organization_id, ''), true
          );
          RAISE;
        END;
        PERFORM set_config(
          'payops.organization_id', COALESCE(prior_organization_id, ''), true
        );
        RETURN NEW;
      END
      $function$
    $definition$,
    schema_name
  );

  EXECUTE pg_catalog.format(
    'CREATE TRIGGER organization_production_control_default
       AFTER INSERT ON %1$I.organization
       FOR EACH ROW EXECUTE FUNCTION %1$I.payops_create_production_control_for_organization()',
    schema_name
  );

  EXECUTE pg_catalog.format(
    $definition$
      CREATE OR REPLACE FUNCTION %1$I.payops_lock_production_activation_mode(
        p_organization_id uuid
      ) RETURNS text
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, %1$I, pg_temp
      SET row_security = on
      AS $function$
      DECLARE
        mode text;
      BEGIN
        IF p_organization_id IS DISTINCT FROM %1$I.payops_current_organization_id() THEN
          RAISE EXCEPTION 'organization scope mismatch' USING ERRCODE = '42501';
        END IF;
        SELECT activation_mode INTO mode
        FROM %1$I.organization_production_controls
        WHERE organization_id = p_organization_id
        FOR SHARE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'production control not found' USING ERRCODE = 'P0002';
        END IF;
        RETURN mode;
      END
      $function$
    $definition$,
    schema_name
  );

  EXECUTE pg_catalog.format(
    $definition$
      CREATE OR REPLACE FUNCTION %1$I.payops_attest_production_readiness(
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
        IF p_evaluated_at < transaction_timestamp() - interval '1 minute'
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

  EXECUTE pg_catalog.format(
    $definition$
      CREATE OR REPLACE FUNCTION %1$I.payops_request_production_promotion(
        p_organization_id uuid,
        p_expected_version integer,
        p_promoted_at timestamptz,
        p_promoted_by text,
        p_actor_kind text,
        p_audit_request_id uuid,
        p_attestation_id uuid
      ) RETURNS TABLE (
        outcome text,
        organization_id uuid,
        activation_mode text,
        version integer,
        promoted_at timestamptz,
        promoted_by text,
        created_at timestamptz,
        updated_at timestamptz,
        complete_watch_coverage boolean,
        fresh_worker_heartbeat boolean,
        two_active_production_rpc_roles boolean,
        no_open_critical_incident boolean
      )
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, %1$I, pg_temp
      SET row_security = on
      AS $function$
      DECLARE
        control %1$I.organization_production_controls%%ROWTYPE;
        attestation %1$I.production_readiness_attestations%%ROWTYPE;
        eligible boolean;
      BEGIN
        IF p_organization_id IS DISTINCT FROM %1$I.payops_current_organization_id() THEN
          RAISE EXCEPTION 'organization scope mismatch' USING ERRCODE = '42501';
        END IF;
        IF p_actor_kind NOT IN ('session', 'api_key', 'system')
          OR p_promoted_by IS NULL OR char_length(p_promoted_by) NOT BETWEEN 1 AND 128
          OR p_promoted_at < transaction_timestamp() - interval '5 minutes'
          OR p_promoted_at > transaction_timestamp() + interval '5 minutes'
        THEN
          RAISE EXCEPTION 'invalid production promotion input' USING ERRCODE = '22023';
        END IF;
        SELECT * INTO control
        FROM %1$I.organization_production_controls
        WHERE organization_production_controls.organization_id = p_organization_id
        FOR UPDATE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'production control not found' USING ERRCODE = 'P0002';
        END IF;
        IF control.activation_mode = 'live' THEN
          RETURN QUERY SELECT 'already_live', control.organization_id,
            control.activation_mode, control.version, control.promoted_at,
            control.promoted_by, control.created_at, control.updated_at,
            NULL::boolean, NULL::boolean, NULL::boolean, NULL::boolean;
          RETURN;
        END IF;
        IF control.version <> p_expected_version THEN
          RAISE EXCEPTION 'production control version conflict' USING ERRCODE = '40001';
        END IF;
        SELECT * INTO attestation
        FROM %1$I.production_readiness_attestations
        WHERE production_readiness_attestations.organization_id = p_organization_id
          AND id = p_attestation_id
          AND control_version = p_expected_version
          AND evaluated_at <= transaction_timestamp()
          AND expires_at >= transaction_timestamp()
        ORDER BY evaluated_at DESC, id DESC
        LIMIT 1;
        eligible := FOUND
          AND attestation.complete_watch_coverage
          AND attestation.fresh_worker_heartbeat
          AND attestation.two_active_production_rpc_roles
          AND attestation.no_open_critical_incident;
        IF NOT eligible THEN
          INSERT INTO %1$I.audit_events (
            id, organization_id, actor_kind, actor_id, action, object_kind,
            object_id, request_id, outcome, reason_code, occurred_at
          ) VALUES (
            gen_random_uuid(), p_organization_id, p_actor_kind, p_promoted_by,
            'production_control.promote', 'organization_production_control',
            p_organization_id::text, p_audit_request_id, 'rejected',
            'prerequisites_incomplete', p_promoted_at
          );
          RETURN QUERY SELECT 'blocked', control.organization_id,
            control.activation_mode, control.version, control.promoted_at,
            control.promoted_by, control.created_at, control.updated_at,
            COALESCE(attestation.complete_watch_coverage, false),
            COALESCE(attestation.fresh_worker_heartbeat, false),
            COALESCE(attestation.two_active_production_rpc_roles, false),
            COALESCE(attestation.no_open_critical_incident, false);
          RETURN;
        END IF;
        UPDATE %1$I.organization_production_controls AS controls
        SET activation_mode = 'live', version = 2,
          promoted_at = p_promoted_at, promoted_by = p_promoted_by,
          updated_at = p_promoted_at
        WHERE controls.organization_id = p_organization_id;
        SELECT * INTO control FROM %1$I.organization_production_controls
        WHERE organization_production_controls.organization_id = p_organization_id;
        INSERT INTO %1$I.audit_events (
          id, organization_id, actor_kind, actor_id, action, object_kind,
          object_id, request_id, outcome, reason_code, occurred_at
        ) VALUES (
          gen_random_uuid(), p_organization_id, p_actor_kind, p_promoted_by,
          'production_control.promote', 'organization_production_control',
          p_organization_id::text, p_audit_request_id, 'succeeded',
          'promoted_live', p_promoted_at
        );
        RETURN QUERY SELECT 'promoted', control.organization_id,
          control.activation_mode, control.version, control.promoted_at,
          control.promoted_by, control.created_at, control.updated_at,
          attestation.complete_watch_coverage,
          attestation.fresh_worker_heartbeat,
          attestation.two_active_production_rpc_roles,
          attestation.no_open_critical_incident;
      END
      $function$
    $definition$,
    schema_name
  );

  EXECUTE pg_catalog.format(
    $definition$
      CREATE OR REPLACE FUNCTION %1$I.payops_record_shadow_projection_decision(
        p_id uuid,
        p_organization_id uuid,
        p_chain_event_id bigint,
        p_source_event_id text,
        p_attempt_id uuid,
        p_parser_version text,
        p_proposed_classification text,
        p_proposed_invoice_id uuid,
        p_proposed_invoice_status text,
        p_proposed_journal_source text,
        p_rule_code text,
        p_rule_version text,
        p_canonical_input_digest text,
        p_occurred_at timestamptz
      ) RETURNS boolean
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, %1$I, pg_temp
      SET row_security = on
      AS $function$
      DECLARE
        inserted_rows integer;
      BEGIN
        IF p_organization_id IS DISTINCT FROM %1$I.payops_current_organization_id() THEN
          RAISE EXCEPTION 'organization scope mismatch' USING ERRCODE = '42501';
        END IF;
        IF NOT EXISTS (
          SELECT 1
          FROM %1$I.chain_events AS event
          JOIN %1$I.event_references AS reference ON reference.chain_event_id = event.id
          JOIN %1$I.hosted_payment_expectations AS expectation
            ON expectation.organization_id = p_organization_id
            AND expectation.reference_address = reference.reference_address
            AND expectation.attempt_id = p_attempt_id
            AND expectation.active
          WHERE event.id = p_chain_event_id
            AND event.event_id = p_source_event_id
            AND event.current_state = 'finalized'
            AND p_parser_version = (
              SELECT transfer.parser_version
              FROM %1$I.normalized_transfers AS transfer
              WHERE transfer.chain_event_id = event.id
              ORDER BY %1$I.payops_semver_key(transfer.parser_version) DESC,
                transfer.parser_version DESC LIMIT 1
            )
        ) OR NOT EXISTS (
          SELECT 1 FROM %1$I.organization_production_controls
          WHERE organization_id = p_organization_id AND activation_mode = 'shadow'
        ) THEN
          RAISE EXCEPTION 'invalid shadow projection source' USING ERRCODE = '23514';
        END IF;
        INSERT INTO %1$I.shadow_projection_decisions (
          id, organization_id, chain_event_id, source_event_id, attempt_id,
          proposed_classification, proposed_invoice_id,
          proposed_invoice_status, proposed_journal_source, rule_code,
          rule_version, canonical_input_digest, occurred_at, created_at
        ) VALUES (
          p_id, p_organization_id, p_chain_event_id, p_source_event_id,
          p_attempt_id, p_proposed_classification, p_proposed_invoice_id,
          p_proposed_invoice_status, p_proposed_journal_source, p_rule_code,
          p_rule_version, p_canonical_input_digest, p_occurred_at,
          clock_timestamp()
        )
        ON CONFLICT (
          organization_id, chain_event_id, attempt_id,
          canonical_input_digest, rule_version
        ) DO NOTHING;
        GET DIAGNOSTICS inserted_rows = ROW_COUNT;
        RETURN inserted_rows = 1;
      END
      $function$
    $definition$,
    schema_name
  );
END
$migration$;

REVOKE ALL ON production_readiness_attestations FROM PUBLIC;
REVOKE ALL ON FUNCTION payops_lock_production_activation_mode(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION payops_attest_production_readiness(
  uuid, integer, boolean, boolean, boolean, boolean, timestamptz, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION payops_request_production_promotion(
  uuid, integer, timestamptz, text, text, uuid, uuid
) FROM PUBLIC;
REVOKE ALL ON FUNCTION payops_record_shadow_projection_decision(
  uuid, uuid, bigint, text, uuid, text, text, uuid, text, text, text,
  text, text, timestamptz
) FROM PUBLIC;

DO $migration$
BEGIN
  IF pg_catalog.to_regprocedure(
    pg_catalog.format('%I.payops_finalize_production_control_authority()', current_schema())
  ) IS NULL THEN
    RAISE EXCEPTION 'production role bootstrap is required before migration 4012'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

SELECT payops_finalize_production_control_authority();
