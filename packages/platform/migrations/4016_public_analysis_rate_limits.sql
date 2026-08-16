CREATE TABLE public_analysis_rate_limit_buckets (
  scope_digest text NOT NULL CHECK (scope_digest ~ '^[0-9a-f]{64}$'),
  bucket_started_at timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_digest, bucket_started_at)
);

CREATE INDEX public_analysis_rate_limit_expiry
  ON public_analysis_rate_limit_buckets (bucket_started_at);

REVOKE ALL ON public_analysis_rate_limit_buckets FROM PUBLIC;

SELECT payops_finalize_production_control_authority();
