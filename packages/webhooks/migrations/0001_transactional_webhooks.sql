CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  url text NOT NULL CHECK (length(url) BETWEEN 1 AND 2048),
  secret_env text NOT NULL CHECK (secret_env ~ '^[A-Za-z_][A-Za-z0-9_]{0,127}$'),
  previous_secret_env text CHECK (
    previous_secret_env IS NULL
    OR previous_secret_env ~ '^[A-Za-z_][A-Za-z0-9_]{0,127}$'
  ),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'disabled')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook_events (
  id uuid PRIMARY KEY,
  event_type text NOT NULL CHECK (
    event_type IN (
      'invoice.issued',
      'payment.detected',
      'payment.confirmed',
      'payment.finalized',
      'payment.confirmation_revoked',
      'payment.exception_created',
      'invoice.partial',
      'invoice.paid',
      'invoice.overpaid',
      'refund.prepared',
      'refund.finalized',
      'evidence.ready'
    )
  ),
  source_type text NOT NULL CHECK (
    source_type IN (
      'invoice',
      'payment',
      'payment_exception',
      'refund',
      'evidence_pack'
    )
  ),
  source_id text NOT NULL CHECK (length(source_id) > 0),
  source_version integer NOT NULL CHECK (source_version > 0),
  payload text NOT NULL CHECK (length(payload) > 0),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  CHECK (
    (event_type IN (
      'invoice.issued',
      'invoice.partial',
      'invoice.paid',
      'invoice.overpaid'
    ) AND source_type = 'invoice')
    OR (event_type IN (
      'payment.detected',
      'payment.confirmed',
      'payment.finalized',
      'payment.confirmation_revoked'
    ) AND source_type = 'payment')
    OR (event_type = 'payment.exception_created' AND source_type = 'payment_exception')
    OR (event_type IN (
      'refund.prepared',
      'refund.finalized'
    ) AND source_type = 'refund')
    OR (event_type = 'evidence.ready' AND source_type = 'evidence_pack')
  ),
  UNIQUE (event_type, source_type, source_id, source_version)
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint_id text NOT NULL REFERENCES webhook_endpoints(id),
  event_id uuid NOT NULL REFERENCES webhook_events(id),
  state text NOT NULL DEFAULT 'pending' CHECK (
    state IN ('pending', 'in_flight', 'retry_wait', 'succeeded', 'dead')
  ),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  first_attempt_at timestamptz,
  next_attempt_at timestamptz,
  lease_token uuid,
  lease_expires_at timestamptz,
  last_status_code integer CHECK (
    last_status_code IS NULL OR last_status_code BETWEEN 100 AND 599
  ),
  last_error_code text CHECK (
    last_error_code IS NULL OR length(last_error_code) BETWEEN 1 AND 128
  ),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (endpoint_id, event_id),
  CHECK (
    (state = 'in_flight') =
    (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
  ),
  CHECK (
    (state IN ('pending', 'retry_wait', 'in_flight') AND next_attempt_at IS NOT NULL)
    OR (state IN ('succeeded', 'dead') AND next_attempt_at IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS webhook_delivery_attempts (
  delivery_id uuid NOT NULL REFERENCES webhook_deliveries(id),
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  outcome text CHECK (outcome IN ('succeeded', 'retry_wait', 'dead', 'abandoned')),
  http_status integer CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  error_code text CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 128),
  duration_ms integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
  PRIMARY KEY (delivery_id, attempt_number),
  CHECK (completed_at IS NULL OR completed_at >= started_at),
  CHECK (
    (completed_at IS NULL AND outcome IS NULL AND http_status IS NULL
      AND error_code IS NULL AND duration_ms IS NULL)
    OR (completed_at IS NOT NULL AND outcome IS NOT NULL AND duration_ms IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS webhook_deliveries_due
  ON webhook_deliveries(next_attempt_at, created_at, id)
  WHERE state IN ('pending', 'retry_wait', 'in_flight');

CREATE INDEX IF NOT EXISTS webhook_deliveries_event
  ON webhook_deliveries(event_id, endpoint_id);

CREATE OR REPLACE FUNCTION payops_reject_webhook_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'webhook event payloads are immutable';
END;
$$;

DROP TRIGGER IF EXISTS webhook_events_immutable ON webhook_events;
CREATE TRIGGER webhook_events_immutable
  BEFORE UPDATE OR DELETE ON webhook_events
  FOR EACH ROW EXECUTE FUNCTION payops_reject_webhook_event_mutation();

CREATE OR REPLACE FUNCTION payops_guard_webhook_attempt_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'webhook delivery attempts are append-only';
  END IF;
  IF OLD.completed_at IS NOT NULL THEN
    RAISE EXCEPTION 'completed webhook delivery attempts are immutable';
  END IF;
  IF NEW.delivery_id <> OLD.delivery_id
    OR NEW.attempt_number <> OLD.attempt_number
    OR NEW.started_at <> OLD.started_at
    OR NEW.completed_at IS NULL THEN
    RAISE EXCEPTION 'webhook delivery attempt identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS webhook_delivery_attempts_append_only
  ON webhook_delivery_attempts;
CREATE TRIGGER webhook_delivery_attempts_append_only
  BEFORE UPDATE OR DELETE ON webhook_delivery_attempts
  FOR EACH ROW EXECUTE FUNCTION payops_guard_webhook_attempt_history();
