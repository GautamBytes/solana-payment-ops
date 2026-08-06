CREATE TABLE IF NOT EXISTS rpc_providers (
  id text PRIMARY KEY,
  cluster text NOT NULL CHECK (cluster IN ('mainnet-beta', 'devnet', 'localnet')),
  endpoint_env text NOT NULL,
  endpoint_label text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS watch_targets (
  id text PRIMARY KEY,
  provider_id text NOT NULL REFERENCES rpc_providers(id),
  cluster text NOT NULL CHECK (cluster IN ('mainnet-beta', 'devnet', 'localnet')),
  address text NOT NULL,
  cutover_slot numeric(20, 0) NOT NULL,
  cutover_signature text,
  overlap_slots numeric(20, 0) NOT NULL CHECK (overlap_slots >= 32),
  committed_head_slot numeric(20, 0),
  committed_head_signature text,
  coverage text NOT NULL DEFAULT 'complete' CHECK (coverage IN ('complete', 'incomplete')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS watch_targets_active_identity
  ON watch_targets(provider_id, cluster, address)
  WHERE active;

CREATE TABLE IF NOT EXISTS sync_runs (
  id uuid PRIMARY KEY,
  provider_id text NOT NULL REFERENCES rpc_providers(id),
  watch_target_id text NOT NULL REFERENCES watch_targets(id),
  starting_head_signature text,
  starting_head_slot numeric(20, 0),
  captured_head_signature text,
  captured_head_slot numeric(20, 0),
  result text NOT NULL DEFAULT 'running' CHECK (result IN ('running', 'complete', 'incomplete')),
  coverage text NOT NULL DEFAULT 'complete' CHECK (coverage IN ('complete', 'incomplete')),
  error_code text,
  pages_read integer NOT NULL DEFAULT 0,
  signatures_discovered integer NOT NULL DEFAULT 0,
  signatures_stored integer NOT NULL DEFAULT 0,
  events_stored integer NOT NULL DEFAULT 0,
  retries_created integer NOT NULL DEFAULT 0,
  quarantines_created integer NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL,
  completed_at timestamptz
);

CREATE TABLE IF NOT EXISTS sync_run_pages (
  run_id uuid NOT NULL REFERENCES sync_runs(id) ON DELETE CASCADE,
  page_number integer NOT NULL,
  before_signature text,
  newest_slot numeric(20, 0),
  oldest_slot numeric(20, 0),
  signature_digest text NOT NULL,
  signatures jsonb NOT NULL,
  PRIMARY KEY (run_id, page_number)
);

CREATE TABLE IF NOT EXISTS raw_transactions (
  id bigserial PRIMARY KEY,
  provider_id text NOT NULL REFERENCES rpc_providers(id),
  signature text NOT NULL,
  commitment text NOT NULL CHECK (commitment IN ('confirmed', 'finalized')),
  digest text NOT NULL,
  canonical_body text NOT NULL,
  body jsonb NOT NULL,
  byte_length integer NOT NULL,
  retrieved_at timestamptz NOT NULL,
  UNIQUE (provider_id, signature, commitment, digest)
);

CREATE INDEX IF NOT EXISTS raw_transactions_signature
  ON raw_transactions(provider_id, signature);

CREATE TABLE IF NOT EXISTS discovered_signatures (
  watch_target_id text NOT NULL REFERENCES watch_targets(id),
  provider_id text NOT NULL REFERENCES rpc_providers(id),
  signature text NOT NULL,
  slot numeric(20, 0) NOT NULL,
  block_time numeric(20, 0),
  rpc_error jsonb,
  confirmation_status text,
  representation_class text NOT NULL CHECK (representation_class IN ('parsed', 'irrelevant', 'failed_transaction', 'quarantined')),
  raw_transaction_id bigint REFERENCES raw_transactions(id),
  parse_digest text,
  finality_state text NOT NULL CHECK (finality_state IN ('detected', 'confirmed', 'finalized', 'failed', 'reverted', 'quarantined')),
  missing_observation_count integer NOT NULL DEFAULT 0,
  first_missing_finalized_slot numeric(20, 0),
  finality_claimed_until timestamptz,
  observed_at timestamptz NOT NULL,
  PRIMARY KEY (watch_target_id, signature)
);

CREATE INDEX IF NOT EXISTS discovered_signatures_finality
  ON discovered_signatures(provider_id, finality_state, finality_claimed_until, slot);

CREATE TABLE IF NOT EXISTS chain_events (
  id bigserial PRIMARY KEY,
  event_id text NOT NULL UNIQUE,
  cluster text NOT NULL,
  signature text NOT NULL,
  outer_instruction_index integer NOT NULL,
  inner_instruction_index integer NOT NULL DEFAULT -1,
  raw_transaction_id bigint NOT NULL REFERENCES raw_transactions(id),
  current_state text NOT NULL CHECK (current_state IN ('detected', 'confirmed', 'finalized', 'failed', 'reverted', 'quarantined')),
  UNIQUE (cluster, signature, outer_instruction_index, inner_instruction_index)
);

CREATE TABLE IF NOT EXISTS normalized_transfers (
  chain_event_id bigint NOT NULL REFERENCES chain_events(id) ON DELETE CASCADE,
  parser_version text NOT NULL,
  program_id text NOT NULL,
  source_token_account text NOT NULL,
  source_account_index integer NOT NULL,
  mint text NOT NULL,
  destination_token_account text NOT NULL,
  destination_account_index integer NOT NULL,
  authority text NOT NULL,
  amount_base_units numeric(78, 0) NOT NULL,
  decimals integer NOT NULL,
  unsupported_extra_accounts jsonb NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (chain_event_id, parser_version)
);

CREATE TABLE IF NOT EXISTS event_references (
  chain_event_id bigint NOT NULL REFERENCES chain_events(id) ON DELETE CASCADE,
  reference_address text NOT NULL,
  PRIMARY KEY (chain_event_id, reference_address)
);

CREATE INDEX IF NOT EXISTS event_references_address
  ON event_references(reference_address);

CREATE TABLE IF NOT EXISTS ingestion_retries (
  id bigserial PRIMARY KEY,
  run_id uuid REFERENCES sync_runs(id) ON DELETE CASCADE,
  provider_id text NOT NULL REFERENCES rpc_providers(id),
  watch_target_id text NOT NULL REFERENCES watch_targets(id),
  signature text,
  operation text NOT NULL,
  code text NOT NULL,
  safe_message text NOT NULL,
  attempt_count integer NOT NULL DEFAULT 1,
  first_failed_at timestamptz NOT NULL,
  last_failed_at timestamptz NOT NULL,
  next_attempt_at timestamptz NOT NULL,
  resolved_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS ingestion_retries_open_operation
  ON ingestion_retries(operation, provider_id, watch_target_id, COALESCE(signature, ''))
  WHERE resolved_at IS NULL;

CREATE TABLE IF NOT EXISTS ingestion_quarantines (
  id bigserial PRIMARY KEY,
  run_id uuid REFERENCES sync_runs(id) ON DELETE SET NULL,
  provider_id text NOT NULL REFERENCES rpc_providers(id),
  watch_target_id text REFERENCES watch_targets(id),
  signature text,
  raw_transaction_id bigint REFERENCES raw_transactions(id),
  code text NOT NULL,
  safe_message text NOT NULL,
  review_state text NOT NULL DEFAULT 'open' CHECK (review_state IN ('open', 'resolved', 'ignored')),
  created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS finality_observations (
  id bigserial PRIMARY KEY,
  provider_id text NOT NULL REFERENCES rpc_providers(id),
  signature text NOT NULL,
  observed_status jsonb,
  observed_state text NOT NULL,
  context_slot numeric(20, 0) NOT NULL,
  response_digest text NOT NULL,
  finalized_raw_transaction_id bigint REFERENCES raw_transactions(id),
  code text,
  observed_at timestamptz NOT NULL,
  UNIQUE (provider_id, signature, observed_state, context_slot, response_digest)
);
