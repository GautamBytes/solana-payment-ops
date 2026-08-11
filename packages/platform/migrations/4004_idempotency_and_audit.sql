CREATE TABLE api_idempotency_records (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  actor_kind text NOT NULL CHECK (actor_kind IN ('session', 'api_key')),
  actor_id text NOT NULL,
  route_id text NOT NULL,
  idempotency_key text NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  state text NOT NULL CHECK (state IN ('in_progress', 'completed')),
  lease_token uuid NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  response_status smallint,
  response_content_type text,
  response_body bytea,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (organization_id, actor_kind, actor_id, route_id, idempotency_key),
  CHECK (
    (state = 'in_progress' AND response_status IS NULL AND response_content_type IS NULL AND response_body IS NULL AND completed_at IS NULL)
    OR
    (state = 'completed' AND response_status BETWEEN 100 AND 599 AND response_content_type IS NOT NULL AND response_body IS NOT NULL AND completed_at IS NOT NULL)
  )
);

CREATE INDEX api_idempotency_expired_leases
  ON api_idempotency_records(lease_expires_at)
  WHERE state = 'in_progress';

CREATE TABLE api_rate_limit_buckets (
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  actor_kind text NOT NULL CHECK (actor_kind IN ('session', 'api_key')),
  actor_id text NOT NULL,
  route_group text NOT NULL,
  bucket_started_at timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (
    organization_id, actor_kind, actor_id, route_group, bucket_started_at
  )
);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  actor_kind text NOT NULL CHECK (actor_kind IN ('session', 'api_key', 'system')),
  actor_id text NOT NULL,
  action text NOT NULL,
  object_kind text NOT NULL,
  object_id text NOT NULL,
  request_id uuid NOT NULL,
  ip_digest text CHECK (ip_digest IS NULL OR ip_digest ~ '^[0-9a-f]{64}$'),
  outcome text NOT NULL CHECK (outcome IN ('succeeded', 'rejected', 'failed')),
  reason_code text NOT NULL,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_events_organization_order
  ON audit_events(organization_id, occurred_at DESC, id DESC);

CREATE OR REPLACE FUNCTION payops_immutable_audit_event()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit events are append-only' USING ERRCODE = '23514';
END
$$;

CREATE TRIGGER audit_events_immutable
BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION payops_immutable_audit_event();

ALTER TABLE api_idempotency_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_idempotency_records FORCE ROW LEVEL SECURITY;
CREATE POLICY api_idempotency_records_tenant_policy ON api_idempotency_records
  USING (organization_id = payops_current_organization_id())
  WITH CHECK (organization_id = payops_current_organization_id());

ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_events_tenant_policy ON audit_events
  USING (organization_id = payops_current_organization_id())
  WITH CHECK (organization_id = payops_current_organization_id());

ALTER TABLE api_rate_limit_buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_rate_limit_buckets FORCE ROW LEVEL SECURITY;
CREATE POLICY api_rate_limit_buckets_tenant_policy ON api_rate_limit_buckets
  USING (organization_id = payops_current_organization_id())
  WITH CHECK (organization_id = payops_current_organization_id());
