ALTER TABLE merchant_invoices
  DROP CONSTRAINT merchant_invoices_status_check;
ALTER TABLE merchant_invoices
  ADD CONSTRAINT merchant_invoices_status_check
  CHECK (status IN ('draft', 'issued', 'paid', 'cancelled'));

CREATE TABLE hosted_payment_expectations (
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  attempt_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  reference_address text NOT NULL,
  recipient_token_account text NOT NULL,
  mint text NOT NULL,
  amount_base_units numeric(20, 0) NOT NULL CHECK (
    amount_base_units BETWEEN 1 AND 18446744073709551615
  ),
  quote_expires_at timestamptz NOT NULL,
  latest_qualifying_at timestamptz NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  deactivated_at timestamptz,
  PRIMARY KEY (organization_id, attempt_id),
  FOREIGN KEY (organization_id, attempt_id)
    REFERENCES payment_attempts(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, invoice_id)
    REFERENCES merchant_invoices(organization_id, id) ON DELETE RESTRICT,
  CHECK (latest_qualifying_at = quote_expires_at + interval '90 seconds'),
  CHECK (
    (active AND deactivated_at IS NULL)
    OR (NOT active AND deactivated_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX hosted_payment_expectations_active_reference
  ON hosted_payment_expectations(reference_address) WHERE active;

CREATE TABLE payment_projections (
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  attempt_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  public_status text NOT NULL CHECK (
    public_status IN (
      'awaiting_payment', 'detected', 'confirmed', 'finalized', 'paid',
      'expired', 'confirmation_revoked', 'exception'
    )
  ),
  source_state text NOT NULL CHECK (
    source_state IN (
      'created', 'quoted', 'awaiting_payment', 'detected', 'confirmed',
      'finalized', 'expired', 'confirmation_revoked', 'allocated', 'exception'
    )
  ),
  version integer NOT NULL CHECK (version > 0),
  detected_at timestamptz,
  confirmed_at timestamptz,
  finalized_at timestamptz,
  paid_at timestamptz,
  exception_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, attempt_id),
  FOREIGN KEY (organization_id, attempt_id)
    REFERENCES payment_attempts(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, invoice_id)
    REFERENCES merchant_invoices(organization_id, id) ON DELETE RESTRICT
);

CREATE TABLE payment_status_history (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  attempt_id uuid NOT NULL,
  source_version integer NOT NULL CHECK (source_version > 0),
  from_status text,
  to_status text NOT NULL CHECK (
    to_status IN (
      'awaiting_payment', 'detected', 'confirmed', 'finalized', 'paid',
      'expired', 'confirmation_revoked', 'exception'
    )
  ),
  reason_code text NOT NULL CHECK (char_length(reason_code) BETWEEN 1 AND 64),
  chain_event_id bigint REFERENCES chain_events(id) ON DELETE RESTRICT,
  event_id text,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, attempt_id, source_version),
  FOREIGN KEY (organization_id, attempt_id)
    REFERENCES payment_attempts(organization_id, id) ON DELETE RESTRICT
);

CREATE TABLE hosted_payment_allocations (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  invoice_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  chain_event_id bigint NOT NULL REFERENCES chain_events(id) ON DELETE RESTRICT,
  parser_version text NOT NULL,
  event_id text NOT NULL CHECK (char_length(event_id) BETWEEN 1 AND 128),
  signature text NOT NULL CHECK (char_length(signature) BETWEEN 64 AND 128),
  outer_instruction_index integer NOT NULL CHECK (outer_instruction_index >= 0),
  inner_instruction_index integer,
  mint text NOT NULL CHECK (char_length(mint) BETWEEN 32 AND 64),
  amount_base_units numeric(20, 0) NOT NULL CHECK (
    amount_base_units BETWEEN 1 AND 18446744073709551615
  ),
  rule_code text NOT NULL CHECK (rule_code = 'exact_match'),
  rule_version text NOT NULL CHECK (char_length(rule_version) BETWEEN 1 AND 64),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  reversed_at timestamptz,
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, invoice_id)
    REFERENCES merchant_invoices(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, attempt_id)
    REFERENCES payment_attempts(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (chain_event_id, parser_version)
    REFERENCES normalized_transfers(chain_event_id, parser_version) ON DELETE RESTRICT,
  UNIQUE (organization_id, chain_event_id),
  CHECK (
    (active AND reversed_at IS NULL)
    OR (NOT active AND reversed_at IS NOT NULL AND reversed_at >= created_at)
  )
);

CREATE UNIQUE INDEX hosted_payment_allocations_active_attempt
  ON hosted_payment_allocations(organization_id, attempt_id) WHERE active;

CREATE TABLE hosted_payment_exceptions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  invoice_id uuid,
  attempt_id uuid NOT NULL,
  chain_event_id bigint NOT NULL REFERENCES chain_events(id) ON DELETE RESTRICT,
  parser_version text NOT NULL,
  event_id text NOT NULL CHECK (char_length(event_id) BETWEEN 1 AND 128),
  signature text NOT NULL CHECK (char_length(signature) BETWEEN 64 AND 128),
  outer_instruction_index integer NOT NULL CHECK (outer_instruction_index >= 0),
  inner_instruction_index integer,
  amount_base_units numeric(20, 0) NOT NULL CHECK (
    amount_base_units BETWEEN 0 AND 18446744073709551615
  ),
  rule_code text NOT NULL CHECK (char_length(rule_code) BETWEEN 1 AND 64),
  rule_version text NOT NULL CHECK (char_length(rule_version) BETWEEN 1 AND 64),
  review_state text NOT NULL DEFAULT 'open' CHECK (
    review_state IN ('open', 'resolved', 'ignored')
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, attempt_id, chain_event_id),
  FOREIGN KEY (organization_id, invoice_id)
    REFERENCES merchant_invoices(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, attempt_id)
    REFERENCES payment_attempts(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (chain_event_id, parser_version)
    REFERENCES normalized_transfers(chain_event_id, parser_version) ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION payops_immutable_payment_history()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'payment status history is append-only' USING ERRCODE = '23514';
END
$$;

CREATE TRIGGER payment_status_history_immutable
BEFORE UPDATE OR DELETE ON payment_status_history
FOR EACH ROW EXECUTE FUNCTION payops_immutable_payment_history();

CREATE OR REPLACE FUNCTION payops_guard_hosted_allocation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.id <> NEW.id
    OR OLD.organization_id <> NEW.organization_id
    OR OLD.invoice_id <> NEW.invoice_id OR OLD.attempt_id <> NEW.attempt_id
    OR OLD.chain_event_id <> NEW.chain_event_id
    OR OLD.parser_version <> NEW.parser_version OR OLD.event_id <> NEW.event_id
    OR OLD.signature <> NEW.signature
    OR OLD.outer_instruction_index <> NEW.outer_instruction_index
    OR OLD.inner_instruction_index IS DISTINCT FROM NEW.inner_instruction_index
    OR OLD.mint <> NEW.mint OR OLD.amount_base_units <> NEW.amount_base_units
    OR OLD.rule_code <> NEW.rule_code OR OLD.rule_version <> NEW.rule_version
    OR OLD.created_at <> NEW.created_at
    OR NOT OLD.active OR NEW.active OR NEW.reversed_at IS NULL
  THEN
    RAISE EXCEPTION 'hosted allocation evidence is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER hosted_payment_allocations_guard
BEFORE UPDATE OR DELETE ON hosted_payment_allocations
FOR EACH ROW EXECUTE FUNCTION payops_guard_hosted_allocation();

CREATE OR REPLACE FUNCTION payops_guard_hosted_exception()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.id <> NEW.id
    OR OLD.organization_id <> NEW.organization_id
    OR OLD.invoice_id IS DISTINCT FROM NEW.invoice_id
    OR OLD.attempt_id <> NEW.attempt_id
    OR OLD.chain_event_id <> NEW.chain_event_id
    OR OLD.parser_version <> NEW.parser_version OR OLD.event_id <> NEW.event_id
    OR OLD.signature <> NEW.signature
    OR OLD.outer_instruction_index <> NEW.outer_instruction_index
    OR OLD.inner_instruction_index IS DISTINCT FROM NEW.inner_instruction_index
    OR OLD.amount_base_units <> NEW.amount_base_units
    OR OLD.rule_code <> NEW.rule_code OR OLD.rule_version <> NEW.rule_version
    OR OLD.created_at <> NEW.created_at
  THEN
    RAISE EXCEPTION 'hosted exception evidence is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER hosted_payment_exceptions_guard
BEFORE UPDATE OR DELETE ON hosted_payment_exceptions
FOR EACH ROW EXECUTE FUNCTION payops_guard_hosted_exception();

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'hosted_payment_expectations', 'payment_projections',
    'payment_status_history', 'hosted_payment_allocations',
    'hosted_payment_exceptions'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (organization_id = payops_current_organization_id()) WITH CHECK (organization_id = payops_current_organization_id())',
      table_name || '_tenant_policy', table_name
    );
  END LOOP;
END
$$;
