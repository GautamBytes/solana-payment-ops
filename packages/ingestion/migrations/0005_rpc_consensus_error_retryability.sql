ALTER TABLE rpc_consensus_provider_observations
  NO FORCE ROW LEVEL SECURITY;
DROP TRIGGER IF EXISTS rpc_consensus_provider_observations_guard
  ON rpc_consensus_provider_observations;

ALTER TABLE rpc_consensus_provider_observations
  ADD COLUMN IF NOT EXISTS safe_error_retryable boolean;
UPDATE rpc_consensus_provider_observations
SET safe_error_retryable = true
WHERE safe_error_code IS NOT NULL
  AND safe_error_retryable IS NULL;

ALTER TABLE rpc_consensus_provider_observations
  DROP CONSTRAINT IF EXISTS
    rpc_consensus_provider_observations_safe_error_code_check;
ALTER TABLE rpc_consensus_provider_observations
  ADD CONSTRAINT rpc_consensus_provider_observations_safe_error_code_check
  CHECK (
    safe_error_code IS NULL OR safe_error_code IN (
      'rpc_transport_error', 'rpc_rate_limited', 'rpc_invalid_json',
      'rpc_error', 'rpc_transaction_missing', 'rpc_signature_conflict',
      'rpc_unsupported_version',
      'rpc_transaction_schema_invalid', 'finality_status_missing'
    )
  );
ALTER TABLE rpc_consensus_provider_observations
  DROP CONSTRAINT IF EXISTS
    rpc_consensus_provider_observations_error_retryability_check;
ALTER TABLE rpc_consensus_provider_observations
  ADD CONSTRAINT rpc_consensus_provider_observations_error_retryability_check
  CHECK (
    (safe_error_code IS NULL AND safe_error_retryable IS NULL)
    OR (safe_error_code IS NOT NULL AND safe_error_retryable IS NOT NULL)
  );
ALTER TABLE rpc_consensus_provider_observations
  DROP CONSTRAINT IF EXISTS
    rpc_consensus_provider_observations_terminal_error_check;
ALTER TABLE rpc_consensus_provider_observations
  ADD CONSTRAINT rpc_consensus_provider_observations_terminal_error_check
  CHECK (
    (safe_error_code <> 'rpc_signature_conflict'
      OR safe_error_retryable = false)
    AND (safe_error_code <> 'rpc_transaction_schema_invalid'
      OR safe_error_retryable = true)
  );

CREATE TRIGGER rpc_consensus_provider_observations_guard
BEFORE INSERT OR UPDATE OR DELETE ON rpc_consensus_provider_observations
FOR EACH ROW EXECUTE FUNCTION payops_guard_rpc_consensus_observation();
ALTER TABLE rpc_consensus_provider_observations
  FORCE ROW LEVEL SECURITY;
