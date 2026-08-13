CREATE OR REPLACE FUNCTION payops_current_organization_id()
RETURNS uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN current_setting('payops.organization_id', true) ~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    THEN current_setting('payops.organization_id', true)::uuid
    ELSE NULL
  END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'rpc_providers'::regclass
      AND conname = 'rpc_providers_id_cluster_unique'
  ) THEN
    ALTER TABLE rpc_providers
      ADD CONSTRAINT rpc_providers_id_cluster_unique UNIQUE (id, cluster);
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS rpc_provider_roles (
  organization_id uuid NOT NULL DEFAULT payops_current_organization_id(),
  cluster text NOT NULL CHECK (cluster IN ('mainnet-beta', 'devnet', 'localnet')),
  role text NOT NULL CHECK (role IN ('primary', 'secondary')),
  provider_id text NOT NULL REFERENCES rpc_providers(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL,
  CHECK (char_length(provider_id) BETWEEN 1 AND 64),
  FOREIGN KEY (provider_id, cluster)
    REFERENCES rpc_providers(id, cluster) ON DELETE RESTRICT,
  UNIQUE (organization_id, cluster, role),
  UNIQUE (organization_id, cluster, provider_id)
);

CREATE OR REPLACE FUNCTION payops_guard_rpc_provider_role()
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
    RAISE EXCEPTION 'RPC provider roles require the guarded workflow'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS rpc_provider_roles_guard ON rpc_provider_roles;
CREATE TRIGGER rpc_provider_roles_guard
BEFORE INSERT OR UPDATE OR DELETE ON rpc_provider_roles
FOR EACH ROW EXECUTE FUNCTION payops_guard_rpc_provider_role();

CREATE TABLE IF NOT EXISTS rpc_consensus_checks (
  id bigserial PRIMARY KEY,
  organization_id uuid NOT NULL DEFAULT payops_current_organization_id(),
  cluster text NOT NULL CHECK (cluster IN ('mainnet-beta', 'devnet', 'localnet')),
  signature text NOT NULL CHECK (char_length(signature) BETWEEN 32 AND 128),
  generation integer NOT NULL CHECK (generation BETWEEN 1 AND 2147483647),
  primary_provider_id text NOT NULL REFERENCES rpc_providers(id) ON DELETE RESTRICT,
  secondary_provider_id text NOT NULL REFERENCES rpc_providers(id) ON DELETE RESTRICT,
  state text NOT NULL DEFAULT 'pending' CHECK (
    state IN ('pending', 'agreed', 'disagreed')
  ),
  claim_token uuid NOT NULL,
  claimed_until timestamptz NOT NULL,
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  CHECK (primary_provider_id <> secondary_provider_id),
  CHECK (completed_at IS NULL OR completed_at >= started_at),
  CHECK (state = 'pending' OR completed_at IS NOT NULL),
  CHECK (char_length(primary_provider_id) BETWEEN 1 AND 64),
  CHECK (char_length(secondary_provider_id) BETWEEN 1 AND 64),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, cluster, signature, generation)
);

CREATE INDEX IF NOT EXISTS rpc_consensus_checks_pending_claims
  ON rpc_consensus_checks(organization_id, claimed_until, started_at)
  WHERE state = 'pending' AND completed_at IS NULL;

CREATE TABLE IF NOT EXISTS rpc_consensus_provider_observations (
  id bigserial PRIMARY KEY,
  organization_id uuid NOT NULL DEFAULT payops_current_organization_id(),
  consensus_check_id bigint NOT NULL,
  generation integer NOT NULL CHECK (generation BETWEEN 1 AND 2147483647),
  provider_id text NOT NULL REFERENCES rpc_providers(id) ON DELETE RESTRICT,
  canonical_digest text CHECK (
    canonical_digest IS NULL OR canonical_digest ~ '^[0-9a-f]{64}$'
  ),
  snapshot_digest text CHECK (
    snapshot_digest IS NULL OR snapshot_digest ~ '^[0-9a-f]{64}$'
  ),
  parsing_digest text CHECK (
    parsing_digest IS NULL OR parsing_digest ~ '^[0-9a-f]{64}$'
  ),
  transfer_identity_digest text CHECK (
    transfer_identity_digest IS NULL
    OR transfer_identity_digest ~ '^[0-9a-f]{64}$'
  ),
  slot numeric(20, 0) CHECK (slot IS NULL OR slot >= 0),
  execution_state text CHECK (
    execution_state IS NULL OR execution_state IN ('succeeded', 'failed')
  ),
  execution_digest text CHECK (
    execution_digest IS NULL OR execution_digest ~ '^[0-9a-f]{64}$'
  ),
  finality text CHECK (
    finality IS NULL OR char_length(finality) BETWEEN 1 AND 32
  ),
  response_time_ms integer NOT NULL CHECK (response_time_ms BETWEEN 0 AND 300000),
  safe_error_code text CHECK (
    safe_error_code IS NULL OR safe_error_code IN (
      'rpc_transport_error', 'rpc_rate_limited', 'rpc_invalid_json',
      'rpc_error', 'rpc_transaction_missing',
      'rpc_transaction_schema_invalid', 'finality_status_missing'
    )
  ),
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (created_at >= observed_at),
  CHECK (char_length(provider_id) BETWEEN 1 AND 64),
  CHECK (
    (
      canonical_digest IS NOT NULL
      AND snapshot_digest IS NOT NULL
      AND parsing_digest IS NOT NULL
      AND transfer_identity_digest IS NOT NULL
      AND slot IS NOT NULL
      AND execution_state IS NOT NULL
      AND execution_digest IS NOT NULL
      AND finality IS NOT NULL
      AND safe_error_code IS NULL
    ) OR (
      canonical_digest IS NULL
      AND snapshot_digest IS NULL
      AND parsing_digest IS NULL
      AND transfer_identity_digest IS NULL
      AND slot IS NULL
      AND execution_state IS NULL
      AND execution_digest IS NULL
      AND finality IS NULL
      AND safe_error_code IS NOT NULL
    )
  ),
  FOREIGN KEY (organization_id, consensus_check_id)
    REFERENCES rpc_consensus_checks(organization_id, id) ON DELETE RESTRICT,
  UNIQUE (consensus_check_id, provider_id)
);

CREATE OR REPLACE FUNCTION payops_guard_rpc_consensus_check()
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

  IF TG_OP = 'DELETE' OR CURRENT_USER <> table_owner THEN
    RAISE EXCEPTION 'RPC consensus checks require the guarded workflow'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    OLD.organization_id <> NEW.organization_id
    OR OLD.cluster <> NEW.cluster
    OR OLD.signature <> NEW.signature
    OR OLD.generation <> NEW.generation
    OR OLD.primary_provider_id <> NEW.primary_provider_id
    OR OLD.secondary_provider_id <> NEW.secondary_provider_id
    OR OLD.claim_token <> NEW.claim_token
    OR OLD.claimed_until <> NEW.claimed_until
    OR OLD.started_at <> NEW.started_at
    OR OLD.completed_at IS NOT NULL
    OR OLD.state <> 'pending'
    OR NEW.completed_at IS NULL
  ) THEN
    RAISE EXCEPTION 'RPC consensus check evidence is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS rpc_consensus_checks_guard ON rpc_consensus_checks;
CREATE TRIGGER rpc_consensus_checks_guard
BEFORE INSERT OR UPDATE OR DELETE ON rpc_consensus_checks
FOR EACH ROW EXECUTE FUNCTION payops_guard_rpc_consensus_check();

CREATE OR REPLACE FUNCTION payops_guard_rpc_consensus_observation()
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
    RAISE EXCEPTION 'RPC provider observations are immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS rpc_consensus_provider_observations_guard
  ON rpc_consensus_provider_observations;
CREATE TRIGGER rpc_consensus_provider_observations_guard
BEFORE INSERT OR UPDATE OR DELETE ON rpc_consensus_provider_observations
FOR EACH ROW EXECUTE FUNCTION payops_guard_rpc_consensus_observation();

ALTER TABLE rpc_provider_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE rpc_provider_roles FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rpc_provider_roles_tenant_policy ON rpc_provider_roles;
CREATE POLICY rpc_provider_roles_tenant_policy ON rpc_provider_roles
  USING (organization_id = payops_current_organization_id())
  WITH CHECK (organization_id = payops_current_organization_id());

ALTER TABLE rpc_consensus_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE rpc_consensus_checks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rpc_consensus_checks_tenant_policy
  ON rpc_consensus_checks;
CREATE POLICY rpc_consensus_checks_tenant_policy ON rpc_consensus_checks
  USING (organization_id = payops_current_organization_id())
  WITH CHECK (organization_id = payops_current_organization_id());

ALTER TABLE rpc_consensus_provider_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE rpc_consensus_provider_observations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rpc_consensus_provider_observations_tenant_policy
  ON rpc_consensus_provider_observations;
CREATE POLICY rpc_consensus_provider_observations_tenant_policy
  ON rpc_consensus_provider_observations
  USING (organization_id = payops_current_organization_id())
  WITH CHECK (organization_id = payops_current_organization_id());

REVOKE INSERT, UPDATE, DELETE ON rpc_provider_roles FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON rpc_consensus_checks FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE
  ON rpc_consensus_provider_observations FROM PUBLIC;
REVOKE TRUNCATE, REFERENCES, TRIGGER
  ON rpc_provider_roles, rpc_consensus_checks,
  rpc_consensus_provider_observations FROM PUBLIC;
