CREATE TABLE IF NOT EXISTS pilot_runs (
  id uuid PRIMARY KEY,
  pilot_id uuid NOT NULL,
  manifest_digest text NOT NULL CHECK (manifest_digest ~ '^[0-9a-f]{64}$'),
  manifest_body text NOT NULL,
  invoice_digest text NOT NULL CHECK (invoice_digest ~ '^[0-9a-f]{64}$'),
  state text NOT NULL CHECK (state IN ('running', 'complete', 'incomplete', 'failed')),
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  UNIQUE (pilot_id, manifest_digest)
);

CREATE TABLE IF NOT EXISTS pilot_run_stages (
  run_id uuid NOT NULL REFERENCES pilot_runs(id),
  stage text NOT NULL CHECK (stage IN ('configure','import_invoices','sync','finality','reconcile','report')),
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 6),
  state text NOT NULL CHECK (state IN ('pending','in_flight','succeeded','failed')),
  lease_token uuid,
  lease_expires_at timestamptz,
  result jsonb,
  error_code text,
  started_at timestamptz,
  completed_at timestamptz,
  PRIMARY KEY (run_id, stage),
  UNIQUE (run_id, ordinal),
  CHECK (
    (state = 'in_flight' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR
    (state <> 'in_flight' AND lease_token IS NULL AND lease_expires_at IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS pilot_reports (
  run_id uuid NOT NULL REFERENCES pilot_runs(id),
  audience text NOT NULL CHECK (audience IN ('private','redacted')),
  format text NOT NULL CHECK (format IN ('json','csv','html')),
  content_digest text NOT NULL CHECK (content_digest ~ '^[0-9a-f]{64}$'),
  byte_length integer NOT NULL CHECK (byte_length > 0),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (run_id, audience, format)
);

CREATE OR REPLACE FUNCTION payops_reject_completed_pilot_stage_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.state = 'succeeded' THEN
    RAISE EXCEPTION 'completed pilot stages are immutable';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

DROP TRIGGER IF EXISTS pilot_completed_stage_immutable ON pilot_run_stages;
CREATE TRIGGER pilot_completed_stage_immutable
BEFORE UPDATE OR DELETE ON pilot_run_stages
FOR EACH ROW
EXECUTE FUNCTION payops_reject_completed_pilot_stage_mutation();

CREATE OR REPLACE FUNCTION payops_reject_pilot_report_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'pilot report metadata is immutable';
END;
$$;

DROP TRIGGER IF EXISTS pilot_report_immutable ON pilot_reports;
CREATE TRIGGER pilot_report_immutable
BEFORE UPDATE OR DELETE ON pilot_reports
FOR EACH ROW
EXECUTE FUNCTION payops_reject_pilot_report_mutation();
