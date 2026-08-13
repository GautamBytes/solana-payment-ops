ALTER TABLE rpc_consensus_provider_observations
  NO FORCE ROW LEVEL SECURITY;
DROP TRIGGER IF EXISTS rpc_consensus_provider_observations_guard
  ON rpc_consensus_provider_observations;

ALTER TABLE rpc_consensus_provider_observations
  ADD COLUMN IF NOT EXISTS status_slot numeric(20, 0),
  ADD COLUMN IF NOT EXISTS status_execution_digest text,
  ADD COLUMN IF NOT EXISTS transaction_execution_digest text;

UPDATE rpc_consensus_provider_observations
SET status_slot = slot,
  status_execution_digest = execution_digest,
  transaction_execution_digest = execution_digest
WHERE canonical_digest IS NOT NULL
  AND (
    status_slot IS NULL
    OR status_execution_digest IS NULL
    OR transaction_execution_digest IS NULL
  );

ALTER TABLE rpc_consensus_provider_observations
  DROP CONSTRAINT IF EXISTS
    rpc_consensus_provider_observations_internal_evidence_check;
ALTER TABLE rpc_consensus_provider_observations
  ADD CONSTRAINT rpc_consensus_provider_observations_internal_evidence_check
  CHECK (
    (
      canonical_digest IS NOT NULL
      AND status_slot IS NOT NULL
      AND status_execution_digest IS NOT NULL
      AND transaction_execution_digest IS NOT NULL
    ) OR (
      canonical_digest IS NULL
      AND status_slot IS NULL
      AND status_execution_digest IS NULL
      AND transaction_execution_digest IS NULL
    )
  );
ALTER TABLE rpc_consensus_provider_observations
  DROP CONSTRAINT IF EXISTS
    rpc_consensus_provider_observations_slot_bounds_check;
ALTER TABLE rpc_consensus_provider_observations
  ADD CONSTRAINT rpc_consensus_provider_observations_slot_bounds_check
  CHECK (
    (slot IS NULL OR slot BETWEEN 0 AND 18446744073709551615)
    AND (
      status_slot IS NULL
      OR status_slot BETWEEN 0 AND 18446744073709551615
    )
  );
ALTER TABLE rpc_consensus_provider_observations
  DROP CONSTRAINT IF EXISTS
    rpc_consensus_provider_observations_status_execution_digest_check;
ALTER TABLE rpc_consensus_provider_observations
  ADD CONSTRAINT
    rpc_consensus_provider_observations_status_execution_digest_check
  CHECK (
    status_execution_digest IS NULL
    OR status_execution_digest ~ '^[0-9a-f]{64}$'
  );
ALTER TABLE rpc_consensus_provider_observations
  DROP CONSTRAINT IF EXISTS
    rpc_consensus_provider_observations_transaction_execution_digest_check;
ALTER TABLE rpc_consensus_provider_observations
  ADD CONSTRAINT
    rpc_consensus_provider_observations_transaction_execution_digest_check
  CHECK (
    transaction_execution_digest IS NULL
    OR transaction_execution_digest ~ '^[0-9a-f]{64}$'
  );

CREATE TRIGGER rpc_consensus_provider_observations_guard
BEFORE INSERT OR UPDATE OR DELETE ON rpc_consensus_provider_observations
FOR EACH ROW EXECUTE FUNCTION payops_guard_rpc_consensus_observation();
ALTER TABLE rpc_consensus_provider_observations
  FORCE ROW LEVEL SECURITY;
