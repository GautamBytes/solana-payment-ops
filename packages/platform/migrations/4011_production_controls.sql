CREATE TABLE organization_production_controls (
  organization_id uuid PRIMARY KEY REFERENCES organization(id) ON DELETE RESTRICT,
  activation_mode text NOT NULL DEFAULT 'shadow' CHECK (
    activation_mode IN ('shadow', 'live')
  ),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  promoted_at timestamptz,
  promoted_by text CHECK (
    promoted_by IS NULL OR char_length(promoted_by) BETWEEN 1 AND 128
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (
      activation_mode = 'shadow' AND version = 1
      AND promoted_at IS NULL AND promoted_by IS NULL
    ) OR (
      activation_mode = 'live' AND version = 2
      AND promoted_at IS NOT NULL AND promoted_by IS NOT NULL
      AND updated_at = promoted_at
    )
  )
);

INSERT INTO organization_production_controls (organization_id)
SELECT id FROM organization
ON CONFLICT (organization_id) DO NOTHING;

CREATE TABLE shadow_projection_decisions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  chain_event_id bigint NOT NULL REFERENCES chain_events(id) ON DELETE RESTRICT,
  source_event_id text NOT NULL CHECK (
    char_length(source_event_id) BETWEEN 1 AND 128
  ),
  attempt_id uuid NOT NULL,
  proposed_classification text NOT NULL CHECK (
    proposed_classification IN ('allocation', 'exception')
  ),
  proposed_invoice_id uuid,
  proposed_invoice_status text NOT NULL CHECK (
    proposed_invoice_status IN ('paid', 'unchanged')
  ),
  proposed_journal_source text CHECK (
    proposed_journal_source IS NULL
    OR proposed_journal_source IN ('payment_received', 'unapplied_receipt')
  ),
  rule_code text NOT NULL CHECK (
    rule_code ~ '^[a-z][a-z0-9_]{0,63}$'
  ),
  rule_version text NOT NULL CHECK (
    rule_version ~ '^[0-9]+\.[0-9]+(?:\.[0-9]+)?$'
  ),
  canonical_input_digest text NOT NULL CHECK (
    canonical_input_digest ~ '^[0-9a-f]{64}$'
  ),
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (
    organization_id, chain_event_id, attempt_id,
    canonical_input_digest, rule_version
  ),
  FOREIGN KEY (organization_id, attempt_id)
    REFERENCES payment_attempts(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, proposed_invoice_id)
    REFERENCES merchant_invoices(organization_id, id) ON DELETE RESTRICT,
  CHECK (created_at >= occurred_at),
  CHECK (
    (
      proposed_classification = 'allocation'
      AND proposed_invoice_id IS NOT NULL
      AND proposed_invoice_status = 'paid'
      AND proposed_journal_source = 'payment_received'
    ) OR (
      proposed_classification = 'exception'
      AND proposed_invoice_status = 'unchanged'
      AND (
        proposed_journal_source IS NULL
        OR proposed_journal_source = 'unapplied_receipt'
      )
    )
  )
);

CREATE INDEX shadow_projection_decisions_order
  ON shadow_projection_decisions(organization_id, occurred_at DESC, id DESC);

CREATE OR REPLACE FUNCTION payops_guard_production_control()
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

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'production controls cannot be deleted'
      USING ERRCODE = '23514';
  END IF;
  IF CURRENT_USER <> table_owner THEN
    RAISE EXCEPTION 'production controls require the privileged workflow'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.activation_mode <> 'shadow' OR NEW.version <> 1
      OR NEW.promoted_at IS NOT NULL OR NEW.promoted_by IS NOT NULL
    THEN
      RAISE EXCEPTION 'organizations must start in shadow mode'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.activation_mode <> 'shadow' OR NEW.activation_mode <> 'live'
    OR OLD.version <> 1 OR NEW.version <> 2
    OR OLD.organization_id <> NEW.organization_id
    OR OLD.created_at <> NEW.created_at
    OR NEW.promoted_at IS NULL OR NEW.promoted_by IS NULL
    OR NEW.updated_at <> NEW.promoted_at
  THEN
    RAISE EXCEPTION 'production controls require the guarded workflow'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER organization_production_controls_guard
BEFORE INSERT OR UPDATE OR DELETE ON organization_production_controls
FOR EACH ROW EXECUTE FUNCTION payops_guard_production_control();

CREATE OR REPLACE FUNCTION payops_guard_shadow_projection_decision()
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
    RAISE EXCEPTION 'shadow projection evidence is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER shadow_projection_decisions_guard
BEFORE INSERT OR UPDATE OR DELETE ON shadow_projection_decisions
FOR EACH ROW EXECUTE FUNCTION payops_guard_shadow_projection_decision();

ALTER TABLE organization_production_controls ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_production_controls FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_production_controls_tenant_policy
  ON organization_production_controls
  USING (organization_id = payops_current_organization_id())
  WITH CHECK (organization_id = payops_current_organization_id());

ALTER TABLE shadow_projection_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE shadow_projection_decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY shadow_projection_decisions_tenant_policy
  ON shadow_projection_decisions
  USING (organization_id = payops_current_organization_id())
  WITH CHECK (organization_id = payops_current_organization_id());

DO $migration$
DECLARE
  schema_name name := current_schema();
BEGIN
  EXECUTE pg_catalog.format(
    $definition$
      CREATE OR REPLACE FUNCTION %1$I.payops_ensure_production_control(
        p_organization_id uuid
      ) RETURNS void
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, %1$I, pg_temp
      SET row_security = on
      AS $function$
      BEGIN
        IF p_organization_id IS DISTINCT FROM
          %1$I.payops_current_organization_id()
        THEN
          RAISE EXCEPTION 'organization scope mismatch'
            USING ERRCODE = '42501';
        END IF;

        INSERT INTO %1$I.organization_production_controls (organization_id)
        VALUES (p_organization_id)
        ON CONFLICT (organization_id) DO NOTHING;
      END
      $function$
    $definition$,
    schema_name
  );

  EXECUTE pg_catalog.format(
    $definition$
      CREATE OR REPLACE FUNCTION %1$I.payops_promote_production_control(
        p_organization_id uuid,
        p_expected_version integer,
        p_promoted_at timestamptz,
        p_promoted_by text
      ) RETURNS TABLE (
        organization_id uuid,
        activation_mode text,
        version integer,
        promoted_at timestamptz,
        promoted_by text,
        created_at timestamptz,
        updated_at timestamptz
      )
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog, %1$I, pg_temp
      SET row_security = on
      AS $function$
      BEGIN
        IF p_organization_id IS DISTINCT FROM
          %1$I.payops_current_organization_id()
        THEN
          RAISE EXCEPTION 'organization scope mismatch'
            USING ERRCODE = '42501';
        END IF;

        RETURN QUERY
        UPDATE %1$I.organization_production_controls AS controls
        SET activation_mode = 'live', version = 2,
          promoted_at = p_promoted_at, promoted_by = p_promoted_by,
          updated_at = p_promoted_at
        WHERE controls.organization_id = p_organization_id
          AND controls.activation_mode = 'shadow'
          AND controls.version = p_expected_version
        RETURNING controls.organization_id, controls.activation_mode,
          controls.version, controls.promoted_at, controls.promoted_by,
          controls.created_at, controls.updated_at;
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
        IF p_organization_id IS DISTINCT FROM
          %1$I.payops_current_organization_id()
        THEN
          RAISE EXCEPTION 'organization scope mismatch'
            USING ERRCODE = '42501';
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
          p_occurred_at
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

REVOKE INSERT, UPDATE, DELETE ON organization_production_controls FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON shadow_projection_decisions FROM PUBLIC;
REVOKE TRUNCATE, REFERENCES, TRIGGER
  ON organization_production_controls FROM PUBLIC;
REVOKE TRUNCATE, REFERENCES, TRIGGER
  ON shadow_projection_decisions FROM PUBLIC;
REVOKE ALL ON FUNCTION payops_ensure_production_control(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION payops_promote_production_control(
  uuid, integer, timestamptz, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION payops_record_shadow_projection_decision(
  uuid, uuid, bigint, text, uuid, text, uuid, text, text, text, text,
  text, timestamptz
) FROM PUBLIC;
