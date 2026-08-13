SELECT payops_finalize_production_control_authority();

CREATE TABLE operational_measurements (
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN (
    'rpc_consensus_checks', 'rpc_consensus_disagreements',
    'ingestion_gap_seconds', 'worker_heartbeat_age_seconds',
    'ledger_mismatches', 'webhook_dead_letters',
    'webhook_delivery_duration_milliseconds'
  )),
  unit text NOT NULL CHECK (unit IN ('count', 'seconds', 'milliseconds')),
  window_seconds integer NOT NULL CHECK (window_seconds = 300),
  bucket_start timestamptz NOT NULL,
  value numeric(20, 6) NOT NULL CHECK (
    value >= 0 AND value <= 99999999999999
  ),
  sample_count integer NOT NULL CHECK (
    sample_count BETWEEN 1 AND 1000000000
  ),
  generated_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, kind, bucket_start),
  CHECK (
    date_bin(
      interval '5 minutes', bucket_start,
      timestamptz '1970-01-01 00:00:00+00'
    ) = bucket_start
  ),
  CHECK (
    generated_at >= bucket_start
    AND generated_at < bucket_start + interval '5 minutes'
  ),
  CHECK (
    (kind IN (
      'rpc_consensus_checks', 'rpc_consensus_disagreements',
      'ledger_mismatches', 'webhook_dead_letters'
    ) AND unit = 'count' AND value = trunc(value))
    OR (kind IN (
      'ingestion_gap_seconds', 'worker_heartbeat_age_seconds'
    ) AND unit = 'seconds')
    OR (
      kind = 'webhook_delivery_duration_milliseconds'
      AND unit = 'milliseconds'
    )
  )
);

CREATE INDEX operational_measurements_recent
  ON operational_measurements(organization_id, bucket_start DESC, kind);

CREATE TABLE operational_incidents (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN (
    'rpc_disagreement', 'ingestion_gap', 'worker_stale',
    'ledger_mismatch', 'webhook_dead_letter'
  )),
  severity text NOT NULL CHECK (severity IN ('warning', 'critical')),
  scope_key text NOT NULL CHECK (scope_key ~ '^[0-9a-f]{64}$'),
  state text NOT NULL CHECK (state IN ('open', 'acknowledged', 'resolved')),
  version integer NOT NULL CHECK (version BETWEEN 1 AND 2147483647),
  first_observed_at timestamptz NOT NULL,
  last_observed_at timestamptz NOT NULL,
  occurrence_count integer NOT NULL CHECK (
    occurrence_count BETWEEN 1 AND 1000000000
  ),
  acknowledged_at timestamptz,
  acknowledged_actor_kind text CHECK (
    acknowledged_actor_kind IS NULL
    OR acknowledged_actor_kind IN ('system', 'session', 'api_key')
  ),
  resolved_at timestamptz,
  resolved_actor_kind text CHECK (
    resolved_actor_kind IS NULL
    OR resolved_actor_kind IN ('system', 'session', 'api_key')
  ),
  resolution_code text CHECK (
    resolution_code IS NULL
    OR resolution_code IN ('condition_cleared', 'operator_resolved')
  ),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (organization_id, id),
  CHECK (last_observed_at >= first_observed_at),
  CHECK (updated_at >= created_at),
  CHECK (
    (acknowledged_at IS NULL) = (acknowledged_actor_kind IS NULL)
  ),
  CHECK (
    (resolved_at IS NULL)
      = (resolved_actor_kind IS NULL AND resolution_code IS NULL)
  ),
  CHECK (
    (state = 'open' AND acknowledged_at IS NULL AND resolved_at IS NULL)
    OR (state = 'acknowledged'
      AND acknowledged_at IS NOT NULL AND resolved_at IS NULL)
    OR (state = 'resolved' AND resolved_at IS NOT NULL)
  ),
  CHECK (acknowledged_at IS NULL OR acknowledged_at >= first_observed_at),
  CHECK (resolved_at IS NULL OR resolved_at >= first_observed_at)
);

CREATE UNIQUE INDEX operational_incidents_one_active_scope
  ON operational_incidents(organization_id, kind, scope_key)
  WHERE state IN ('open', 'acknowledged');

CREATE INDEX operational_incidents_newest
  ON operational_incidents(
    organization_id, last_observed_at DESC, id DESC
  );

CREATE TABLE operational_incident_events (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  incident_id uuid NOT NULL,
  incident_version integer NOT NULL CHECK (
    incident_version BETWEEN 1 AND 2147483647
  ),
  action text NOT NULL CHECK (
    action IN ('opened', 'reobserved', 'acknowledged', 'resolved')
  ),
  from_state text CHECK (
    from_state IS NULL OR from_state IN ('open', 'acknowledged')
  ),
  to_state text NOT NULL CHECK (
    to_state IN ('open', 'acknowledged', 'resolved')
  ),
  occurrence_count integer NOT NULL CHECK (
    occurrence_count BETWEEN 1 AND 1000000000
  ),
  actor_kind text NOT NULL CHECK (
    actor_kind IN ('system', 'session', 'api_key')
  ),
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, incident_id, incident_version),
  FOREIGN KEY (organization_id, incident_id)
    REFERENCES operational_incidents(organization_id, id) ON DELETE RESTRICT,
  CHECK (created_at >= occurred_at),
  CHECK (
    (action = 'opened' AND from_state IS NULL AND to_state = 'open'
      AND occurrence_count = 1)
    OR (action = 'reobserved' AND from_state = to_state
      AND to_state IN ('open', 'acknowledged') AND occurrence_count >= 2)
    OR (action = 'acknowledged' AND from_state = 'open'
      AND to_state = 'acknowledged')
    OR (action = 'resolved' AND from_state IN ('open', 'acknowledged')
      AND to_state = 'resolved')
  )
);

CREATE INDEX operational_incident_events_history
  ON operational_incident_events(
    organization_id, incident_id, incident_version DESC, id DESC
  );

CREATE TABLE operational_health_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  dedupe_key text NOT NULL CHECK (dedupe_key ~ '^[0-9a-f]{64}$'),
  measurement_kind text CHECK (
    measurement_kind IS NULL OR measurement_kind IN (
      'rpc_consensus_checks', 'rpc_consensus_disagreements',
      'ingestion_gap_seconds', 'worker_heartbeat_age_seconds',
      'ledger_mismatches', 'webhook_dead_letters',
      'webhook_delivery_duration_milliseconds'
    )
  ),
  measurement_value numeric(20, 6) CHECK (
    measurement_value IS NULL OR (
      measurement_value >= 0 AND measurement_value <= 99999999999999
    )
  ),
  incident_kind text CHECK (
    incident_kind IS NULL OR incident_kind IN (
      'rpc_disagreement', 'ingestion_gap', 'worker_stale',
      'ledger_mismatch', 'webhook_dead_letter'
    )
  ),
  incident_severity text CHECK (
    incident_severity IS NULL
    OR incident_severity IN ('warning', 'critical')
  ),
  incident_action text CHECK (
    incident_action IS NULL OR incident_action IN ('observe', 'resolve')
  ),
  scope_key text CHECK (
    scope_key IS NULL OR scope_key ~ '^[0-9a-f]{64}$'
  ),
  observed_at timestamptz NOT NULL,
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, dedupe_key),
  CHECK ((measurement_kind IS NULL) = (measurement_value IS NULL)),
  CHECK (
    (incident_kind IS NULL AND incident_severity IS NULL
      AND incident_action IS NULL AND scope_key IS NULL)
    OR (incident_kind IS NOT NULL AND incident_severity IS NOT NULL
      AND incident_action IS NOT NULL AND scope_key IS NOT NULL)
  ),
  CHECK (measurement_kind IS NOT NULL OR incident_kind IS NOT NULL)
);

CREATE INDEX operational_health_signals_pending
  ON operational_health_signals(organization_id, created_at, id)
  WHERE processed_at IS NULL;

CREATE FUNCTION payops_guard_operational_health_record()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  table_owner name;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(class.relowner) INTO table_owner
  FROM pg_catalog.pg_class AS class WHERE class.oid = TG_RELID;
  IF CURRENT_USER IS DISTINCT FROM table_owner THEN
    RAISE EXCEPTION 'operational health requires the privileged workflow'
      USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'operational_incident_events' AND TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'operational incident history is append-only'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER operational_measurements_privileged_workflow
BEFORE INSERT OR UPDATE OR DELETE ON operational_measurements
FOR EACH ROW EXECUTE FUNCTION payops_guard_operational_health_record();
CREATE TRIGGER operational_incidents_privileged_workflow
BEFORE INSERT OR UPDATE OR DELETE ON operational_incidents
FOR EACH ROW EXECUTE FUNCTION payops_guard_operational_health_record();
CREATE TRIGGER operational_incident_events_append_only
BEFORE INSERT OR UPDATE OR DELETE ON operational_incident_events
FOR EACH ROW EXECUTE FUNCTION payops_guard_operational_health_record();
CREATE TRIGGER operational_health_signals_privileged_workflow
BEFORE INSERT OR UPDATE OR DELETE ON operational_health_signals
FOR EACH ROW EXECUTE FUNCTION payops_guard_operational_health_record();

ALTER TABLE operational_measurements ENABLE ROW LEVEL SECURITY;
ALTER TABLE operational_measurements FORCE ROW LEVEL SECURITY;
CREATE POLICY operational_measurements_tenant_policy
  ON operational_measurements
  USING (organization_id = payops_current_organization_id())
  WITH CHECK (organization_id = payops_current_organization_id());
ALTER TABLE operational_incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE operational_incidents FORCE ROW LEVEL SECURITY;
CREATE POLICY operational_incidents_tenant_policy
  ON operational_incidents
  USING (organization_id = payops_current_organization_id())
  WITH CHECK (organization_id = payops_current_organization_id());
ALTER TABLE operational_incident_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE operational_incident_events FORCE ROW LEVEL SECURITY;
CREATE POLICY operational_incident_events_tenant_policy
  ON operational_incident_events
  USING (organization_id = payops_current_organization_id())
  WITH CHECK (organization_id = payops_current_organization_id());
ALTER TABLE operational_health_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE operational_health_signals FORCE ROW LEVEL SECURITY;
CREATE POLICY operational_health_signals_tenant_policy
  ON operational_health_signals
  USING (organization_id = payops_current_organization_id())
  WITH CHECK (organization_id = payops_current_organization_id());

DO $migration$
DECLARE
  schema_name name := current_schema();
BEGIN
  EXECUTE pg_catalog.format(
    $definition$
      CREATE OR REPLACE FUNCTION %1$I.payops_record_operational_measurement(
        p_organization_id uuid,
        p_kind text,
        p_value numeric,
        p_generated_at timestamptz
      ) RETURNS void
      LANGUAGE plpgsql SECURITY DEFINER
      SET search_path = pg_catalog, %1$I, pg_temp
      SET row_security = on
      AS $function$
      DECLARE
        unit_name text;
        target_bucket timestamptz;
      BEGIN
        IF p_organization_id IS DISTINCT FROM %1$I.payops_current_organization_id()
        THEN RAISE EXCEPTION 'organization scope mismatch' USING ERRCODE = '42501';
        END IF;
        unit_name := CASE
          WHEN p_kind IN (
            'rpc_consensus_checks', 'rpc_consensus_disagreements',
            'ledger_mismatches', 'webhook_dead_letters'
          ) THEN 'count'
          WHEN p_kind IN (
            'ingestion_gap_seconds', 'worker_heartbeat_age_seconds'
          ) THEN 'seconds'
          WHEN p_kind = 'webhook_delivery_duration_milliseconds'
            THEN 'milliseconds'
          ELSE NULL
        END;
        IF unit_name IS NULL OR p_value IS NULL THEN
          RAISE EXCEPTION 'invalid operational measurement' USING ERRCODE = '22023';
        END IF;
        target_bucket := date_bin(
          interval '5 minutes', p_generated_at,
          timestamptz '1970-01-01 00:00:00+00'
        );
        INSERT INTO %1$I.operational_measurements (
          organization_id, kind, unit, window_seconds, bucket_start,
          value, sample_count, generated_at
        ) VALUES (
          p_organization_id, p_kind, unit_name, 300, target_bucket,
          p_value, 1, p_generated_at
        ) ON CONFLICT ON CONSTRAINT operational_measurements_pkey DO UPDATE SET
          value = least(
            %1$I.operational_measurements.value + EXCLUDED.value,
            99999999999999::numeric
          ),
          sample_count = least(
            %1$I.operational_measurements.sample_count + 1,
            1000000000
          ),
          generated_at = greatest(
            %1$I.operational_measurements.generated_at, EXCLUDED.generated_at
          );
      END
      $function$
    $definition$, schema_name
  );

  EXECUTE pg_catalog.format(
    $definition$
      CREATE OR REPLACE FUNCTION %1$I.payops_observe_operational_incident(
        p_organization_id uuid,
        p_actor_kind text,
        p_kind text,
        p_severity text,
        p_scope_key text,
        p_observed_at timestamptz
      ) RETURNS uuid
      LANGUAGE plpgsql SECURITY DEFINER
      SET search_path = pg_catalog, %1$I, pg_temp
      SET row_security = on
      AS $function$
      DECLARE
        active %1$I.operational_incidents%%ROWTYPE;
        incident_id uuid;
        next_version integer;
        next_occurrence integer;
      BEGIN
        IF p_organization_id IS DISTINCT FROM %1$I.payops_current_organization_id()
        THEN RAISE EXCEPTION 'organization scope mismatch' USING ERRCODE = '42501';
        END IF;
        IF p_actor_kind NOT IN ('system', 'session', 'api_key') THEN
          RAISE EXCEPTION 'invalid operational actor' USING ERRCODE = '22023';
        END IF;
        IF p_kind IS NULL OR p_severity IS NULL OR p_scope_key IS NULL
          OR p_kind NOT IN (
          'rpc_disagreement', 'ingestion_gap', 'worker_stale',
          'ledger_mismatch', 'webhook_dead_letter'
        ) OR p_severity NOT IN ('warning', 'critical')
          OR p_scope_key !~ '^[0-9a-f]{64}$'
        THEN
          RAISE EXCEPTION 'invalid operational incident' USING ERRCODE = '22023';
        END IF;
        PERFORM pg_advisory_xact_lock(hashtextextended(
          p_organization_id::text || ':operational-health-authority', 0
        ));
        PERFORM pg_advisory_xact_lock(hashtextextended(
          p_organization_id::text || ':' || p_kind || ':' || p_scope_key, 0
        ));
        SELECT incident.* INTO active
        FROM %1$I.operational_incidents AS incident
        WHERE incident.organization_id = p_organization_id
          AND incident.kind = p_kind AND incident.scope_key = p_scope_key
          AND incident.state IN ('open', 'acknowledged')
        FOR UPDATE;
        IF NOT FOUND THEN
          incident_id := gen_random_uuid();
          INSERT INTO %1$I.operational_incidents (
            id, organization_id, kind, severity, scope_key, state, version,
            first_observed_at, last_observed_at, occurrence_count,
            created_at, updated_at
          ) VALUES (
            incident_id, p_organization_id, p_kind, p_severity, p_scope_key,
            'open', 1, p_observed_at, p_observed_at, 1,
            p_observed_at, p_observed_at
          );
          INSERT INTO %1$I.operational_incident_events (
            id, organization_id, incident_id, incident_version, action,
            from_state, to_state, occurrence_count, actor_kind,
            occurred_at, created_at
          ) VALUES (
            gen_random_uuid(), p_organization_id, incident_id, 1, 'opened',
            NULL, 'open', 1, p_actor_kind, p_observed_at, p_observed_at
          );
          RETURN incident_id;
        END IF;
        next_version := active.version + 1;
        next_occurrence := active.occurrence_count + 1;
        UPDATE %1$I.operational_incidents AS incident SET
          severity = CASE
            WHEN incident.severity = 'critical' OR p_severity = 'critical'
              THEN 'critical' ELSE 'warning' END,
          version = next_version,
          first_observed_at = least(incident.first_observed_at, p_observed_at),
          last_observed_at = greatest(incident.last_observed_at, p_observed_at),
          occurrence_count = next_occurrence,
          updated_at = greatest(incident.updated_at, p_observed_at)
        WHERE incident.organization_id = p_organization_id
          AND incident.id = active.id;
        INSERT INTO %1$I.operational_incident_events (
          id, organization_id, incident_id, incident_version, action,
          from_state, to_state, occurrence_count, actor_kind,
          occurred_at, created_at
        ) VALUES (
          gen_random_uuid(), p_organization_id, active.id, next_version,
          'reobserved', active.state, active.state, next_occurrence,
          p_actor_kind, p_observed_at, p_observed_at
        );
        RETURN active.id;
      END
      $function$
    $definition$, schema_name
  );

  EXECUTE pg_catalog.format(
    $definition$
      CREATE OR REPLACE FUNCTION %1$I.payops_acknowledge_operational_incident(
        p_organization_id uuid, p_incident_id uuid,
        p_expected_version integer, p_actor_kind text,
        p_acknowledged_at timestamptz
      ) RETURNS void
      LANGUAGE plpgsql SECURITY DEFINER
      SET search_path = pg_catalog, %1$I, pg_temp
      SET row_security = on
      AS $function$
      DECLARE current_incident %1$I.operational_incidents%%ROWTYPE;
      BEGIN
        IF p_organization_id IS DISTINCT FROM %1$I.payops_current_organization_id()
        THEN RAISE EXCEPTION 'organization scope mismatch' USING ERRCODE = '42501';
        END IF;
        IF p_actor_kind NOT IN ('system', 'session', 'api_key') THEN
          RAISE EXCEPTION 'invalid operational actor' USING ERRCODE = '22023';
        END IF;
        PERFORM pg_advisory_xact_lock(hashtextextended(
          p_organization_id::text || ':operational-health-authority', 0
        ));
        SELECT incident.* INTO current_incident
        FROM %1$I.operational_incidents AS incident
        WHERE incident.organization_id = p_organization_id
          AND incident.id = p_incident_id FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'incident not found' USING ERRCODE = 'P0002'; END IF;
        IF current_incident.version <> p_expected_version THEN
          RAISE EXCEPTION 'incident version conflict' USING ERRCODE = '40001';
        END IF;
        IF current_incident.state <> 'open' THEN
          RAISE EXCEPTION 'invalid incident transition' USING ERRCODE = '22023';
        END IF;
        UPDATE %1$I.operational_incidents AS incident SET
          state = 'acknowledged', version = current_incident.version + 1,
          acknowledged_at = p_acknowledged_at,
          acknowledged_actor_kind = p_actor_kind,
          updated_at = greatest(incident.updated_at, p_acknowledged_at)
        WHERE incident.organization_id = p_organization_id
          AND incident.id = p_incident_id;
        INSERT INTO %1$I.operational_incident_events (
          id, organization_id, incident_id, incident_version, action,
          from_state, to_state, occurrence_count, actor_kind,
          occurred_at, created_at
        ) VALUES (
          gen_random_uuid(), p_organization_id, p_incident_id,
          current_incident.version + 1, 'acknowledged', 'open', 'acknowledged',
          current_incident.occurrence_count, p_actor_kind,
          p_acknowledged_at, p_acknowledged_at
        );
      END
      $function$
    $definition$, schema_name
  );

  EXECUTE pg_catalog.format(
    $definition$
      CREATE OR REPLACE FUNCTION %1$I.payops_resolve_operational_incident(
        p_organization_id uuid, p_incident_id uuid,
        p_expected_version integer, p_resolution_code text,
        p_actor_kind text, p_resolved_at timestamptz
      ) RETURNS void
      LANGUAGE plpgsql SECURITY DEFINER
      SET search_path = pg_catalog, %1$I, pg_temp
      SET row_security = on
      AS $function$
      DECLARE current_incident %1$I.operational_incidents%%ROWTYPE;
      BEGIN
        IF p_organization_id IS DISTINCT FROM %1$I.payops_current_organization_id()
        THEN RAISE EXCEPTION 'organization scope mismatch' USING ERRCODE = '42501';
        END IF;
        IF p_actor_kind NOT IN ('system', 'session', 'api_key') THEN
          RAISE EXCEPTION 'invalid operational actor' USING ERRCODE = '22023';
        END IF;
        PERFORM pg_advisory_xact_lock(hashtextextended(
          p_organization_id::text || ':operational-health-authority', 0
        ));
        SELECT incident.* INTO current_incident
        FROM %1$I.operational_incidents AS incident
        WHERE incident.organization_id = p_organization_id
          AND incident.id = p_incident_id FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'incident not found' USING ERRCODE = 'P0002'; END IF;
        IF current_incident.version <> p_expected_version THEN
          RAISE EXCEPTION 'incident version conflict' USING ERRCODE = '40001';
        END IF;
        IF current_incident.state NOT IN ('open', 'acknowledged')
          OR p_resolution_code NOT IN ('condition_cleared', 'operator_resolved')
        THEN RAISE EXCEPTION 'invalid incident transition' USING ERRCODE = '22023';
        END IF;
        UPDATE %1$I.operational_incidents AS incident SET
          state = 'resolved', version = current_incident.version + 1,
          resolved_at = p_resolved_at, resolved_actor_kind = p_actor_kind,
          resolution_code = p_resolution_code,
          updated_at = greatest(incident.updated_at, p_resolved_at)
        WHERE incident.organization_id = p_organization_id
          AND incident.id = p_incident_id;
        INSERT INTO %1$I.operational_incident_events (
          id, organization_id, incident_id, incident_version, action,
          from_state, to_state, occurrence_count, actor_kind,
          occurred_at, created_at
        ) VALUES (
          gen_random_uuid(), p_organization_id, p_incident_id,
          current_incident.version + 1, 'resolved', current_incident.state,
          'resolved', current_incident.occurrence_count, p_actor_kind,
          p_resolved_at, p_resolved_at
        );
      END
      $function$
    $definition$, schema_name
  );
END
$migration$;

DO $migration$
DECLARE schema_name name := current_schema();
BEGIN
  EXECUTE pg_catalog.format(
    $definition$
      CREATE OR REPLACE FUNCTION %1$I.payops_operational_health_clear_for_promotion(
        p_organization_id uuid
      ) RETURNS boolean
      LANGUAGE plpgsql SECURITY DEFINER
      SET search_path = pg_catalog, %1$I, pg_temp
      SET row_security = on
      AS $function$
      BEGIN
        IF p_organization_id IS DISTINCT FROM %1$I.payops_current_organization_id()
        THEN RAISE EXCEPTION 'organization scope mismatch' USING ERRCODE = '42501';
        END IF;
        PERFORM pg_advisory_xact_lock(hashtextextended(
          p_organization_id::text || ':operational-health-authority', 0
        ));
        RETURN NOT EXISTS (
          SELECT 1 FROM %1$I.operational_incidents AS incident
          WHERE incident.organization_id = p_organization_id
            AND incident.severity = 'critical'
            AND incident.state IN ('open', 'acknowledged')
        ) AND NOT EXISTS (
          SELECT 1 FROM %1$I.operational_health_signals AS signal
          WHERE signal.organization_id = p_organization_id
            AND signal.processed_at IS NULL
            AND signal.incident_severity = 'critical'
            AND signal.incident_action = 'observe'
        );
      END
      $function$
    $definition$, schema_name
  );
END
$migration$;

DO $migration$
DECLARE schema_name name := current_schema();
BEGIN
  EXECUTE pg_catalog.format(
    $definition$
      CREATE FUNCTION %1$I.payops_guard_operational_health_promotion()
      RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = pg_catalog, %1$I, pg_temp
      SET row_security = on
      AS $function$
      BEGIN
        IF OLD.activation_mode = 'shadow' AND NEW.activation_mode = 'live'
          AND NOT %1$I.payops_operational_health_clear_for_promotion(
            NEW.organization_id
          )
        THEN
          RAISE EXCEPTION 'production promotion blocked by operational health'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END
      $function$
    $definition$, schema_name
  );
END
$migration$;

DO $migration$
DECLARE schema_name name := current_schema();
BEGIN
  EXECUTE pg_catalog.format(
    $definition$
      CREATE OR REPLACE FUNCTION %1$I.payops_process_operational_health_signals(
        p_organization_id uuid, p_limit integer, p_processed_at timestamptz
      ) RETURNS integer
      LANGUAGE plpgsql SECURITY DEFINER
      SET search_path = pg_catalog, %1$I, pg_temp
      SET row_security = on
      AS $function$
      DECLARE
        signal %1$I.operational_health_signals%%ROWTYPE;
        active %1$I.operational_incidents%%ROWTYPE;
        processed integer := 0;
      BEGIN
        IF p_organization_id IS DISTINCT FROM %1$I.payops_current_organization_id()
          OR p_limit NOT BETWEEN 1 AND 100
        THEN RAISE EXCEPTION 'invalid signal processing input' USING ERRCODE = '22023';
        END IF;
        PERFORM pg_advisory_xact_lock(hashtextextended(
          p_organization_id::text || ':operational-health-authority', 0
        ));
        FOR signal IN
          SELECT * FROM %1$I.operational_health_signals
          WHERE organization_id = p_organization_id AND processed_at IS NULL
          ORDER BY created_at, id LIMIT p_limit FOR UPDATE SKIP LOCKED
        LOOP
          IF signal.measurement_kind IS NOT NULL THEN
            PERFORM %1$I.payops_record_operational_measurement(
              p_organization_id, signal.measurement_kind,
              signal.measurement_value, signal.observed_at
            );
          END IF;
          IF signal.incident_action = 'observe' THEN
            PERFORM %1$I.payops_observe_operational_incident(
              p_organization_id, 'system', signal.incident_kind,
              signal.incident_severity, signal.scope_key, signal.observed_at
            );
          ELSIF signal.incident_action = 'resolve' THEN
            SELECT incident.* INTO active
            FROM %1$I.operational_incidents AS incident
            WHERE incident.organization_id = p_organization_id
              AND incident.kind = signal.incident_kind
              AND incident.scope_key = signal.scope_key
              AND incident.state IN ('open', 'acknowledged')
            FOR UPDATE;
            IF FOUND THEN
              PERFORM %1$I.payops_resolve_operational_incident(
                p_organization_id, active.id, active.version,
                'condition_cleared', 'system', signal.observed_at
              );
            END IF;
          END IF;
          UPDATE %1$I.operational_health_signals
          SET processed_at = p_processed_at
          WHERE organization_id = p_organization_id AND id = signal.id;
          processed := processed + 1;
        END LOOP;
        RETURN processed;
      END
      $function$
    $definition$, schema_name
  );
END
$migration$;

CREATE FUNCTION payops_enqueue_scheduled_operational_health_signals(
  p_organization_id uuid, p_observed_at timestamptz,
  p_rpc_mode text, p_rpc_cluster text,
  p_primary_provider_id text, p_primary_endpoint_env text,
  p_primary_endpoint_digest text, p_secondary_provider_id text,
  p_secondary_endpoint_env text, p_secondary_endpoint_digest text
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, "$user", public, pg_temp
SET row_security = on
AS $$
DECLARE
  heartbeat_age numeric;
  ingestion_age numeric;
  ingestion_threshold numeric;
  worker_action text;
  ingestion_action text;
  inserted integer := 0;
  affected integer := 0;
BEGIN
  IF p_organization_id IS DISTINCT FROM payops_current_organization_id()
  THEN RAISE EXCEPTION 'organization scope mismatch' USING ERRCODE = '42501';
  END IF;
  IF p_rpc_mode IS DISTINCT FROM 'dual_provider'
    OR p_rpc_cluster IS DISTINCT FROM 'mainnet-beta'
    OR p_primary_provider_id IS NULL OR p_secondary_provider_id IS NULL
    OR p_primary_provider_id = p_secondary_provider_id
    OR p_primary_endpoint_env IS NULL OR p_secondary_endpoint_env IS NULL
    OR p_primary_endpoint_digest IS NULL
    OR p_secondary_endpoint_digest IS NULL
    OR p_primary_endpoint_digest !~ '^[0-9a-f]{64}$'
    OR p_secondary_endpoint_digest !~ '^[0-9a-f]{64}$'
    OR p_primary_endpoint_digest = p_secondary_endpoint_digest
  THEN RAISE EXCEPTION 'invalid operational health rpc identity'
    USING ERRCODE = '22023';
  END IF;
  WITH configured_pair AS (
    SELECT
      max(role.provider_id) FILTER (WHERE role.role = 'primary')
        AS primary_provider_id,
      max(role.provider_id) FILTER (WHERE role.role = 'secondary')
        AS secondary_provider_id,
      max(provider.endpoint_env) FILTER (WHERE role.role = 'primary')
        AS primary_endpoint_env,
      max(provider.endpoint_env) FILTER (WHERE role.role = 'secondary')
        AS secondary_endpoint_env
    FROM rpc_provider_roles AS role
    JOIN rpc_providers AS provider
      ON provider.id = role.provider_id
     AND provider.cluster = role.cluster
     AND provider.active
    WHERE role.organization_id = p_organization_id
      AND role.cluster = 'mainnet-beta'
    HAVING count(*) = 2
      AND count(DISTINCT role.provider_id) = 2
      AND count(*) FILTER (WHERE role.role = 'primary') = 1
      AND count(*) FILTER (WHERE role.role = 'secondary') = 1
      AND max(role.provider_id) FILTER (WHERE role.role = 'primary')
        = p_primary_provider_id
      AND max(role.provider_id) FILTER (WHERE role.role = 'secondary')
        = p_secondary_provider_id
      AND max(provider.endpoint_env) FILTER (WHERE role.role = 'primary')
        = p_primary_endpoint_env
      AND max(provider.endpoint_env) FILTER (WHERE role.role = 'secondary')
        = p_secondary_endpoint_env
  )
  SELECT CASE
    WHEN max(instance.last_heartbeat_at) IS NULL THEN 99999999999999
    ELSE greatest(
      0,
      extract(epoch FROM p_observed_at - max(instance.last_heartbeat_at))
    )
  END INTO heartbeat_age
  FROM worker_instances AS instance
  CROSS JOIN configured_pair AS pair
  WHERE instance.state = 'running'
    AND instance.rpc_mode = 'dual_provider'
    AND instance.rpc_cluster = 'mainnet-beta'
    AND instance.primary_provider_id = pair.primary_provider_id
    AND instance.secondary_provider_id = pair.secondary_provider_id
    AND instance.primary_endpoint_env = pair.primary_endpoint_env
    AND instance.secondary_endpoint_env = pair.secondary_endpoint_env
    AND instance.primary_endpoint_digest = p_primary_endpoint_digest
    AND instance.secondary_endpoint_digest = p_secondary_endpoint_digest;
  worker_action := CASE
    WHEN heartbeat_age > 30 THEN 'observe' ELSE 'resolve'
  END;
  INSERT INTO operational_health_signals (
    organization_id, dedupe_key, measurement_kind, measurement_value,
    incident_kind, incident_severity, incident_action, scope_key, observed_at
  ) VALUES (
    p_organization_id,
    md5('worker:' || p_organization_id::text || ':' || p_observed_at::text
      || ':' || worker_action)
      || md5('worker-scope:' || p_organization_id::text || ':'
        || p_observed_at::text || ':' || worker_action),
    'worker_heartbeat_age_seconds', least(heartbeat_age, 99999999999999),
    'worker_stale', 'warning', worker_action,
    md5('worker_stale:production_authority')
      || md5('scope:worker_stale:production_authority'),
    p_observed_at
  ) ON CONFLICT (organization_id, dedupe_key) DO NOTHING;
  GET DIAGNOSTICS affected = ROW_COUNT;
  inserted := inserted + affected;
  WITH configured_pair AS (
    SELECT
      max(role.provider_id) FILTER (WHERE role.role = 'primary')
        AS primary_provider_id,
      max(role.provider_id) FILTER (WHERE role.role = 'secondary')
        AS secondary_provider_id,
      max(provider.endpoint_env) FILTER (WHERE role.role = 'primary')
        AS primary_endpoint_env,
      max(provider.endpoint_env) FILTER (WHERE role.role = 'secondary')
        AS secondary_endpoint_env
    FROM rpc_provider_roles AS role
    JOIN rpc_providers AS provider
      ON provider.id = role.provider_id
     AND provider.cluster = role.cluster
     AND provider.active
    WHERE role.organization_id = p_organization_id
      AND role.cluster = 'mainnet-beta'
    HAVING count(*) = 2
      AND count(DISTINCT role.provider_id) = 2
      AND count(*) FILTER (WHERE role.role = 'primary') = 1
      AND count(*) FILTER (WHERE role.role = 'secondary') = 1
      AND max(role.provider_id) FILTER (WHERE role.role = 'primary')
        = p_primary_provider_id
      AND max(role.provider_id) FILTER (WHERE role.role = 'secondary')
        = p_secondary_provider_id
      AND max(provider.endpoint_env) FILTER (WHERE role.role = 'primary')
        = p_primary_endpoint_env
      AND max(provider.endpoint_env) FILTER (WHERE role.role = 'secondary')
        = p_secondary_endpoint_env
  )
  SELECT CASE
      WHEN instance.id IS NULL THEN 99999999999999
      WHEN state.last_succeeded_at IS NULL THEN 99999999999999
      ELSE greatest(
        0,
        extract(epoch FROM p_observed_at - state.last_succeeded_at)
      )
    END,
    greatest(30, interval_ms * 3 / 1000.0)
  INTO ingestion_age, ingestion_threshold
  FROM worker_job_states AS state
  LEFT JOIN configured_pair AS pair ON true
  LEFT JOIN worker_instances AS instance
    ON instance.id = state.last_success_instance_id
   AND instance.id = state.last_attempt_instance_id
   AND instance.rpc_mode = 'dual_provider'
   AND instance.rpc_cluster = 'mainnet-beta'
   AND instance.primary_provider_id = pair.primary_provider_id
   AND instance.secondary_provider_id = pair.secondary_provider_id
   AND instance.primary_endpoint_env = pair.primary_endpoint_env
   AND instance.secondary_endpoint_env = pair.secondary_endpoint_env
   AND instance.primary_endpoint_digest = p_primary_endpoint_digest
   AND instance.secondary_endpoint_digest = p_secondary_endpoint_digest
   AND instance.state = 'running'
  WHERE state.name = 'ingest_watch_targets' AND state.lifecycle = 'active';
  ingestion_action := CASE
    WHEN ingestion_age > ingestion_threshold THEN 'observe' ELSE 'resolve'
  END;
  INSERT INTO operational_health_signals (
    organization_id, dedupe_key, measurement_kind, measurement_value,
    incident_kind, incident_severity, incident_action, scope_key, observed_at
  ) VALUES (
    p_organization_id,
    md5('ingestion:' || p_organization_id::text || ':' || p_observed_at::text
      || ':' || ingestion_action)
      || md5('ingestion-scope:' || p_organization_id::text || ':'
        || p_observed_at::text || ':' || ingestion_action),
    'ingestion_gap_seconds', least(ingestion_age, 99999999999999),
    'ingestion_gap', 'warning', ingestion_action,
    md5('ingestion_gap:ingest_watch_targets')
      || md5('scope:ingestion_gap:ingest_watch_targets'),
    p_observed_at
  ) ON CONFLICT (organization_id, dedupe_key) DO NOTHING;
  GET DIAGNOSTICS affected = ROW_COUNT;
  inserted := inserted + affected;
  RETURN inserted;
END;
$$;

CREATE FUNCTION payops_enqueue_rpc_consensus_health_signal()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, "$user", public, pg_temp
SET row_security = on
AS $$
DECLARE source_key text := NEW.organization_id::text || ':' || NEW.id::text;
BEGIN
  IF OLD.state = 'pending' AND NEW.state IN ('agreed', 'disagreed')
    AND NEW.completed_at IS NOT NULL
  THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(
      NEW.organization_id::text || ':operational-health-authority', 0
    ));
    INSERT INTO operational_health_signals (
      organization_id, dedupe_key, measurement_kind, measurement_value,
      observed_at
    ) VALUES (
      NEW.organization_id,
      md5('rpc-check:' || source_key) || md5('rpc-check-scope:' || source_key),
      'rpc_consensus_checks', 1, NEW.completed_at
    ) ON CONFLICT (organization_id, dedupe_key) DO NOTHING;
    IF NEW.state = 'disagreed' THEN
      INSERT INTO operational_health_signals (
        organization_id, dedupe_key, measurement_kind, measurement_value,
        incident_kind, incident_severity, incident_action, scope_key,
        observed_at
      ) VALUES (
        NEW.organization_id,
        md5('rpc-disagreement:' || source_key)
          || md5('rpc-disagreement-scope:' || source_key),
        'rpc_consensus_disagreements', 1, 'rpc_disagreement', 'critical',
        'observe', md5('rpc:' || source_key) || md5('scope:rpc:' || source_key),
        NEW.completed_at
      ) ON CONFLICT (organization_id, dedupe_key) DO NOTHING;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER rpc_consensus_checks_health_signal
AFTER UPDATE OF state, completed_at ON rpc_consensus_checks
FOR EACH ROW EXECUTE FUNCTION payops_enqueue_rpc_consensus_health_signal();

CREATE FUNCTION payops_enqueue_webhook_health_signal()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, "$user", public, pg_temp
SET row_security = on
AS $$
DECLARE
  target_organization uuid;
  source_key text;
BEGIN
  IF OLD.completed_at IS NULL AND NEW.completed_at IS NOT NULL THEN
    SELECT event.organization_id INTO target_organization
    FROM webhook_deliveries AS delivery
    JOIN webhook_events AS event ON event.id = delivery.event_id
    WHERE delivery.id = NEW.delivery_id;
    IF target_organization IS NULL THEN
      RAISE EXCEPTION 'webhook health source not found' USING ERRCODE = '23514';
    END IF;
    IF target_organization IS DISTINCT FROM payops_current_organization_id() THEN
      RAISE EXCEPTION 'organization scope mismatch' USING ERRCODE = '42501';
    END IF;
    source_key := target_organization::text || ':' || NEW.delivery_id::text
      || ':' || NEW.attempt_number::text;
    INSERT INTO operational_health_signals (
      organization_id, dedupe_key, measurement_kind, measurement_value,
      observed_at
    ) VALUES (
      target_organization,
      md5('webhook-duration:' || source_key)
        || md5('webhook-duration-scope:' || source_key),
      'webhook_delivery_duration_milliseconds', NEW.duration_ms,
      NEW.completed_at
    ) ON CONFLICT (organization_id, dedupe_key) DO NOTHING;
    IF NEW.outcome = 'dead' THEN
      INSERT INTO operational_health_signals (
        organization_id, dedupe_key, measurement_kind, measurement_value,
        incident_kind, incident_severity, incident_action, scope_key,
        observed_at
      ) VALUES (
        target_organization,
        md5('webhook-dead:' || source_key)
          || md5('webhook-dead-scope:' || source_key),
        'webhook_dead_letters', 1, 'webhook_dead_letter', 'warning',
        'observe', md5('webhook:' || NEW.delivery_id::text)
          || md5('scope:webhook:' || NEW.delivery_id::text), NEW.completed_at
      ) ON CONFLICT (organization_id, dedupe_key) DO NOTHING;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER webhook_delivery_attempts_health_signal
AFTER UPDATE OF completed_at ON webhook_delivery_attempts
FOR EACH ROW EXECUTE FUNCTION payops_enqueue_webhook_health_signal();

CREATE FUNCTION payops_enqueue_ledger_health_signal()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, "$user", public, pg_temp
SET row_security = on
AS $$
DECLARE source_key text := NEW.organization_id::text || ':' || NEW.id::text;
BEGIN
  IF NEW.coverage_state = 'complete' AND NEW.balance_state = 'mismatch' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(
      NEW.organization_id::text || ':operational-health-authority', 0
    ));
    INSERT INTO operational_health_signals (
      organization_id, dedupe_key, measurement_kind, measurement_value,
      incident_kind, incident_severity, incident_action, scope_key, observed_at
    ) VALUES (
      NEW.organization_id,
      md5('ledger:' || source_key) || md5('ledger-scope:' || source_key),
      'ledger_mismatches', 1, 'ledger_mismatch', 'critical', 'observe',
      md5('ledger:' || NEW.id::text) || md5('scope:ledger:' || NEW.id::text),
      NEW.reconciled_at
    ) ON CONFLICT (organization_id, dedupe_key) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER ledger_reconciliations_health_signal
AFTER INSERT ON ledger_reconciliations
FOR EACH ROW EXECUTE FUNCTION payops_enqueue_ledger_health_signal();

DO $migration$
DECLARE target record;
BEGIN
  FOR target IN SELECT id FROM organization LOOP
    PERFORM set_config('payops.organization_id', target.id::text, true);
    INSERT INTO operational_health_signals (
      organization_id, dedupe_key, measurement_kind, measurement_value,
      incident_kind, incident_severity, incident_action, scope_key, observed_at
    )
    SELECT check_record.organization_id,
      md5('rpc-disagreement:' || check_record.organization_id::text || ':'
        || check_record.id::text)
        || md5('rpc-disagreement-scope:' || check_record.organization_id::text
          || ':' || check_record.id::text),
      'rpc_consensus_disagreements', 1, 'rpc_disagreement', 'critical',
      'observe',
      md5('rpc:' || check_record.organization_id::text || ':'
        || check_record.id::text)
        || md5('scope:rpc:' || check_record.organization_id::text || ':'
          || check_record.id::text),
      check_record.completed_at
    FROM rpc_consensus_checks AS check_record
    WHERE check_record.organization_id = target.id
      AND check_record.state = 'disagreed'
      AND check_record.completed_at IS NOT NULL
    ON CONFLICT (organization_id, dedupe_key) DO NOTHING;

    INSERT INTO operational_health_signals (
      organization_id, dedupe_key, measurement_kind, measurement_value,
      incident_kind, incident_severity, incident_action, scope_key, observed_at
    )
    SELECT reconciliation.organization_id,
      md5('ledger:' || reconciliation.organization_id::text || ':'
        || reconciliation.id::text)
        || md5('ledger-scope:' || reconciliation.organization_id::text || ':'
          || reconciliation.id::text),
      'ledger_mismatches', 1, 'ledger_mismatch', 'critical', 'observe',
      md5('ledger:' || reconciliation.id::text)
        || md5('scope:ledger:' || reconciliation.id::text),
      reconciliation.reconciled_at
    FROM ledger_reconciliations AS reconciliation
    WHERE reconciliation.organization_id = target.id
      AND reconciliation.coverage_state = 'complete'
      AND reconciliation.balance_state = 'mismatch'
    ON CONFLICT (organization_id, dedupe_key) DO NOTHING;
  END LOOP;
END
$migration$;

DO $migration$
DECLARE schema_name name := current_schema();
BEGIN
  EXECUTE pg_catalog.format(
    'ALTER FUNCTION %1$I.payops_enqueue_scheduled_operational_health_signals(uuid, timestamptz, text, text, text, text, text, text, text, text) SET search_path TO pg_catalog, %1$I, pg_temp',
    schema_name
  );
  EXECUTE pg_catalog.format(
    'ALTER FUNCTION %1$I.payops_enqueue_rpc_consensus_health_signal() SET search_path TO pg_catalog, %1$I, pg_temp',
    schema_name
  );
  EXECUTE pg_catalog.format(
    'ALTER FUNCTION %1$I.payops_enqueue_webhook_health_signal() SET search_path TO pg_catalog, %1$I, pg_temp',
    schema_name
  );
  EXECUTE pg_catalog.format(
    'ALTER FUNCTION %1$I.payops_enqueue_ledger_health_signal() SET search_path TO pg_catalog, %1$I, pg_temp',
    schema_name
  );
END
$migration$;

DO $migration$
DECLARE schema_name name := current_schema();
BEGIN
  EXECUTE pg_catalog.format(
    $definition$
      CREATE OR REPLACE FUNCTION %1$I.payops_request_production_promotion_4015(
        p_organization_id uuid, p_expected_version integer,
        p_promoted_at timestamptz, p_promoted_by text, p_actor_kind text,
        p_audit_request_id uuid, p_attestation_id uuid
      ) RETURNS TABLE (
        outcome text, organization_id uuid, activation_mode text,
        version integer, promoted_at timestamptz, promoted_by text,
        created_at timestamptz, updated_at timestamptz,
        complete_watch_coverage boolean, fresh_worker_heartbeat boolean,
        two_active_production_rpc_roles boolean,
        no_open_critical_incident boolean
      )
      LANGUAGE plpgsql SECURITY DEFINER
      SET search_path = pg_catalog, %1$I, pg_temp
      SET row_security = on
      AS $function$
      DECLARE
        control %1$I.organization_production_controls%%ROWTYPE;
        attestation %1$I.production_readiness_attestations%%ROWTYPE;
        attestation_found boolean;
        eligible boolean;
        critical_clear boolean;
      BEGIN
        IF p_organization_id IS DISTINCT FROM %1$I.payops_current_organization_id()
        THEN RAISE EXCEPTION 'organization scope mismatch' USING ERRCODE = '42501';
        END IF;
        IF p_actor_kind NOT IN ('session', 'api_key', 'system')
          OR p_promoted_by IS NULL OR char_length(p_promoted_by) NOT BETWEEN 1 AND 128
          OR p_promoted_at < transaction_timestamp() - interval '5 minutes'
          OR p_promoted_at > transaction_timestamp() + interval '5 minutes'
        THEN RAISE EXCEPTION 'invalid production promotion input' USING ERRCODE = '22023';
        END IF;
        PERFORM pg_advisory_xact_lock(hashtextextended(
          p_organization_id::text || ':operational-health-authority', 0
        ));
        SELECT * INTO control FROM %1$I.organization_production_controls
        WHERE organization_production_controls.organization_id = p_organization_id
        FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'production control not found' USING ERRCODE = 'P0002'; END IF;
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
        SELECT * INTO attestation FROM %1$I.production_readiness_attestations
        WHERE production_readiness_attestations.organization_id = p_organization_id
          AND id = p_attestation_id AND control_version = p_expected_version
          AND evaluated_at <= transaction_timestamp()
          AND expires_at >= transaction_timestamp()
        ORDER BY evaluated_at DESC, id DESC LIMIT 1;
        attestation_found := FOUND;
        critical_clear := NOT EXISTS (
          SELECT 1 FROM %1$I.operational_incidents AS incident
          WHERE incident.organization_id = p_organization_id
            AND incident.severity = 'critical'
            AND incident.state IN ('open', 'acknowledged')
        ) AND NOT EXISTS (
          SELECT 1 FROM %1$I.operational_health_signals AS signal
          WHERE signal.organization_id = p_organization_id
            AND signal.processed_at IS NULL
            AND signal.incident_severity = 'critical'
            AND signal.incident_action = 'observe'
        );
        eligible := attestation_found AND attestation.complete_watch_coverage
          AND attestation.fresh_worker_heartbeat
          AND attestation.two_active_production_rpc_roles
          AND attestation.no_open_critical_incident AND critical_clear;
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
            COALESCE(attestation.no_open_critical_incident, false) AND critical_clear;
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
          attestation.complete_watch_coverage, attestation.fresh_worker_heartbeat,
          attestation.two_active_production_rpc_roles, true;
      END
      $function$
    $definition$, schema_name
  );
END
$migration$;

REVOKE ALL ON operational_measurements, operational_incidents,
  operational_incident_events, operational_health_signals FROM PUBLIC;
REVOKE ALL ON FUNCTION payops_guard_operational_health_record() FROM PUBLIC;
REVOKE ALL ON FUNCTION payops_record_operational_measurement(
  uuid, text, numeric, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION payops_observe_operational_incident(
  uuid, text, text, text, text, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION payops_acknowledge_operational_incident(
  uuid, uuid, integer, text, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION payops_resolve_operational_incident(
  uuid, uuid, integer, text, text, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION payops_operational_health_clear_for_promotion(uuid)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION payops_guard_operational_health_promotion()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION payops_request_production_promotion_4015(
  uuid, integer, timestamptz, text, text, uuid, uuid
) FROM PUBLIC;
REVOKE ALL ON FUNCTION payops_process_operational_health_signals(
  uuid, integer, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION payops_enqueue_scheduled_operational_health_signals(
  uuid, timestamptz, text, text, text, text, text, text, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION payops_enqueue_rpc_consensus_health_signal()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION payops_enqueue_webhook_health_signal()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION payops_enqueue_ledger_health_signal()
  FROM PUBLIC;

DO $migration$
DECLARE
  target record;
  remaining integer;
BEGIN
  FOR target IN
    SELECT id AS organization_id FROM organization
  LOOP
    PERFORM set_config('payops.organization_id', target.organization_id::text, true);
    LOOP
      SELECT payops_process_operational_health_signals(
        target.organization_id, 100, clock_timestamp()
      ) INTO remaining;
      EXIT WHEN remaining = 0;
    END LOOP;
  END LOOP;
END
$migration$;

SELECT payops_finalize_production_control_authority();
