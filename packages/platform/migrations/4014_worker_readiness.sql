CREATE TABLE worker_instances (
  id uuid PRIMARY KEY,
  state text NOT NULL CHECK (state IN ('running', 'draining', 'stopped')),
  build_revision text NOT NULL CHECK (
    build_revision ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  ),
  rpc_mode text NOT NULL CHECK (
    rpc_mode IN ('single_provider', 'dual_provider')
  ),
  rpc_cluster text NOT NULL CHECK (
    rpc_cluster IN ('mainnet-beta', 'devnet', 'localnet')
  ),
  primary_provider_id text NOT NULL CHECK (
    primary_provider_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$'
  ),
  primary_endpoint_env text NOT NULL CHECK (
    primary_endpoint_env ~ '^[A-Z][A-Z0-9_]{0,127}$'
  ),
  primary_endpoint_digest text NOT NULL CHECK (
    primary_endpoint_digest ~ '^[0-9a-f]{64}$'
  ),
  secondary_provider_id text CHECK (
    secondary_provider_id IS NULL
    OR secondary_provider_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$'
  ),
  secondary_endpoint_env text CHECK (
    secondary_endpoint_env IS NULL
    OR secondary_endpoint_env ~ '^[A-Z][A-Z0-9_]{0,127}$'
  ),
  secondary_endpoint_digest text CHECK (
    secondary_endpoint_digest IS NULL
    OR secondary_endpoint_digest ~ '^[0-9a-f]{64}$'
  ),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_heartbeat_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  draining_at timestamptz,
  stopped_at timestamptz,
  CHECK (last_heartbeat_at >= started_at),
  CHECK (
    (state = 'running' AND draining_at IS NULL AND stopped_at IS NULL)
    OR (state = 'draining' AND draining_at IS NOT NULL AND stopped_at IS NULL)
    OR (state = 'stopped' AND stopped_at IS NOT NULL)
  ),
  CHECK (draining_at IS NULL OR draining_at >= started_at),
  CHECK (stopped_at IS NULL OR stopped_at >= started_at),
  CHECK (
    (
      rpc_mode = 'single_provider'
      AND secondary_provider_id IS NULL
      AND secondary_endpoint_env IS NULL
      AND secondary_endpoint_digest IS NULL
    )
    OR (
      rpc_mode = 'dual_provider' AND secondary_provider_id IS NOT NULL
      AND secondary_endpoint_env IS NOT NULL
      AND secondary_endpoint_digest IS NOT NULL
      AND primary_provider_id <> secondary_provider_id
    )
  )
);

ALTER TABLE worker_job_states DROP CONSTRAINT worker_job_states_name_check;
ALTER TABLE worker_job_states ADD CONSTRAINT worker_job_states_name_check CHECK (
  name IN (
    'ingest_watch_targets', 'refresh_finality', 'reconcile_attempts',
    'verify_rpc_consensus', 'project_payment_status', 'expire_quotes',
    'send_webhooks'
  )
);

INSERT INTO worker_job_states (name) VALUES ('verify_rpc_consensus')
ON CONFLICT (name) DO NOTHING;

ALTER TABLE worker_job_states
  ADD COLUMN interval_ms integer NOT NULL DEFAULT 2000 CHECK (
    interval_ms BETWEEN 250 AND 60000
  ),
  ADD COLUMN lease_owner_id uuid REFERENCES worker_instances(id) ON DELETE RESTRICT,
  ADD COLUMN lifecycle text NOT NULL DEFAULT 'active' CHECK (
    lifecycle IN ('active', 'retired')
  ),
  ADD COLUMN last_attempt_instance_id uuid REFERENCES worker_instances(id)
    ON DELETE RESTRICT,
  ADD COLUMN last_success_instance_id uuid REFERENCES worker_instances(id)
    ON DELETE RESTRICT,
  ADD COLUMN last_failure_instance_id uuid REFERENCES worker_instances(id)
    ON DELETE RESTRICT,
  ADD COLUMN last_attempted_at timestamptz,
  ADD COLUMN last_succeeded_at timestamptz,
  ADD COLUMN last_failed_at timestamptz,
  ADD COLUMN attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  ADD COLUMN successes integer NOT NULL DEFAULT 0 CHECK (successes >= 0),
  ADD COLUMN failures integer NOT NULL DEFAULT 0 CHECK (failures >= 0),
  ADD COLUMN consecutive_failures integer NOT NULL DEFAULT 0 CHECK (
    consecutive_failures >= 0 AND consecutive_failures <= failures
  ),
  ADD COLUMN last_duration_ms integer CHECK (
    last_duration_ms IS NULL OR last_duration_ms BETWEEN 0 AND 86400000
  ),
  ADD COLUMN last_failure_class text CHECK (
    last_failure_class IS NULL OR last_failure_class IN (
      'dependency', 'configuration', 'contention', 'invariant', 'unknown'
    )
  );

UPDATE worker_job_states
SET last_attempted_at = last_started_at,
  last_succeeded_at = CASE
    WHEN lease_token IS NULL AND last_completed_at IS NOT NULL
      AND last_error_code IS NULL
    THEN last_completed_at ELSE NULL END,
  last_failed_at = CASE
    WHEN lease_token IS NULL AND last_completed_at IS NOT NULL
      AND last_error_code IS NOT NULL
    THEN last_completed_at ELSE NULL END,
  attempts = CASE
    WHEN last_started_at IS NOT NULL OR last_completed_at IS NOT NULL
      OR lease_token IS NOT NULL
    THEN 1 ELSE 0 END,
  successes = CASE
    WHEN lease_token IS NULL AND last_completed_at IS NOT NULL
      AND last_error_code IS NULL
    THEN 1 ELSE 0 END,
  failures = CASE
    WHEN lease_token IS NULL AND last_completed_at IS NOT NULL
      AND last_error_code IS NOT NULL
    THEN 1 ELSE 0 END,
  consecutive_failures = CASE
    WHEN lease_token IS NULL AND last_completed_at IS NOT NULL
      AND last_error_code IS NOT NULL
    THEN 1 ELSE 0 END,
  last_failure_class = CASE
    WHEN lease_token IS NULL AND last_completed_at IS NOT NULL
      AND last_error_code IS NOT NULL
    THEN 'unknown' ELSE NULL END;

UPDATE worker_job_states
SET lease_token = NULL, lease_expires_at = NULL, lease_owner_id = NULL,
  lifecycle = 'retired'
WHERE name = 'reconcile_attempts';

ALTER TABLE worker_job_states ADD CONSTRAINT worker_job_states_owner_lease_check CHECK (
  (lease_token IS NULL AND lease_expires_at IS NULL AND lease_owner_id IS NULL)
  OR (
    lease_token IS NOT NULL AND lease_expires_at IS NOT NULL
  )
);

ALTER TABLE worker_job_states ADD CONSTRAINT worker_job_states_outcome_counts_check CHECK (
  attempts >= successes + failures
);

ALTER TABLE worker_job_states ADD CONSTRAINT worker_job_states_failure_facts_check CHECK (
  (failures = 0 AND last_failed_at IS NULL AND last_failure_class IS NULL)
  OR (failures > 0 AND last_failed_at IS NOT NULL)
);

ALTER TABLE worker_job_states ADD CONSTRAINT worker_job_states_retirement_check CHECK (
  (
    name = 'reconcile_attempts'
    AND lifecycle = 'retired'
    AND lease_token IS NULL
    AND lease_expires_at IS NULL
    AND lease_owner_id IS NULL
  )
  OR (name <> 'reconcile_attempts' AND lifecycle = 'active')
);

CREATE FUNCTION payops_guard_retired_worker_job_lease()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.name = 'reconcile_attempts' AND (
    NEW.lifecycle <> 'retired'
    OR NEW.lease_token IS NOT NULL
    OR NEW.lease_expires_at IS NOT NULL
    OR NEW.lease_owner_id IS NOT NULL
  )
  THEN
    RAISE EXCEPTION 'retired worker jobs cannot be reactivated or leased'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER worker_job_states_retired_lease_guard
BEFORE INSERT OR UPDATE ON worker_job_states
FOR EACH ROW EXECUTE FUNCTION payops_guard_retired_worker_job_lease();

CREATE INDEX worker_instances_fresh_running
  ON worker_instances(last_heartbeat_at DESC)
  WHERE state = 'running';

SELECT payops_finalize_production_control_authority();
