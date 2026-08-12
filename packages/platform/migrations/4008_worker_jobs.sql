CREATE TABLE worker_job_states (
  name text PRIMARY KEY CHECK (
    name IN (
      'ingest_watch_targets', 'refresh_finality', 'reconcile_attempts',
      'project_payment_status', 'expire_quotes', 'send_webhooks'
    )
  ),
  cursor jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
    jsonb_typeof(cursor) = 'object'
  ),
  lease_token uuid,
  lease_expires_at timestamptz,
  last_started_at timestamptz,
  last_completed_at timestamptz,
  last_error_code text CHECK (
    last_error_code IS NULL OR char_length(last_error_code) BETWEEN 1 AND 64
  ),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (lease_token IS NULL AND lease_expires_at IS NULL)
    OR (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
  ),
  CHECK (
    last_completed_at IS NULL OR last_started_at IS NULL
    OR lease_token IS NOT NULL OR last_completed_at >= last_started_at
  )
);

INSERT INTO worker_job_states (name) VALUES
  ('ingest_watch_targets'),
  ('refresh_finality'),
  ('reconcile_attempts'),
  ('project_payment_status'),
  ('expire_quotes'),
  ('send_webhooks');

CREATE INDEX worker_job_states_expired_leases
  ON worker_job_states(lease_expires_at)
  WHERE lease_token IS NOT NULL;
