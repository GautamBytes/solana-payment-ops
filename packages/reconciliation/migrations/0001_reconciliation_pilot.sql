CREATE TABLE IF NOT EXISTS reconciliation_invoices (
  invoice_id text PRIMARY KEY,
  customer_id text NOT NULL,
  expected_mint text NOT NULL,
  destination_token_account text NOT NULL,
  amount_base_units numeric(78, 0) NOT NULL CHECK (amount_base_units > 0),
  reference_address text NOT NULL UNIQUE,
  issued_at timestamptz NOT NULL,
  due_at timestamptz NOT NULL CHECK (due_at > issued_at),
  row_digest text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'matched', 'exception')),
  imported_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS reconciliation_allocations (
  id bigserial PRIMARY KEY,
  invoice_id text NOT NULL UNIQUE REFERENCES reconciliation_invoices(invoice_id),
  chain_event_id bigint NOT NULL UNIQUE REFERENCES chain_events(id),
  event_id text NOT NULL,
  signature text NOT NULL,
  outer_instruction_index integer NOT NULL,
  inner_instruction_index integer,
  amount_base_units numeric(78, 0) NOT NULL CHECK (amount_base_units > 0),
  rule_code text NOT NULL CHECK (rule_code = 'exact_match'),
  rule_version text NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS reconciliation_exceptions (
  id bigserial PRIMARY KEY,
  fingerprint text NOT NULL UNIQUE,
  invoice_id text REFERENCES reconciliation_invoices(invoice_id),
  chain_event_id bigint NOT NULL UNIQUE REFERENCES chain_events(id),
  event_id text NOT NULL,
  signature text NOT NULL,
  outer_instruction_index integer NOT NULL,
  inner_instruction_index integer,
  amount_base_units numeric(78, 0) NOT NULL CHECK (amount_base_units > 0),
  rule_code text NOT NULL CHECK (rule_code <> 'exact_match'),
  rule_version text NOT NULL,
  review_state text NOT NULL DEFAULT 'open' CHECK (review_state IN ('open', 'resolved', 'ignored')),
  created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS reconciliation_runs (
  id uuid PRIMARY KEY,
  result text NOT NULL DEFAULT 'running' CHECK (result IN ('running', 'complete', 'failed')),
  candidates integer NOT NULL DEFAULT 0,
  allocations integer NOT NULL DEFAULT 0,
  exceptions integer NOT NULL DEFAULT 0,
  applied integer NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL,
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS reconciliation_invoices_status
  ON reconciliation_invoices(status, due_at, invoice_id);

CREATE INDEX IF NOT EXISTS reconciliation_exceptions_review
  ON reconciliation_exceptions(review_state, rule_code, id);
