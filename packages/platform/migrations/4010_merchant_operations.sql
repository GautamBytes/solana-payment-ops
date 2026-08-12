ALTER TABLE hosted_payment_exceptions
  DROP CONSTRAINT hosted_payment_exceptions_review_state_check;
ALTER TABLE hosted_payment_exceptions
  ADD CONSTRAINT hosted_payment_exceptions_review_state_check CHECK (
    review_state IN (
      'open', 'assigned', 'investigating', 'escalated', 'resolved', 'ignored'
    )
  ),
  ADD COLUMN assigned_to text,
  ADD COLUMN resolution_code text,
  ADD COLUMN resolution_note text,
  ADD COLUMN resolved_by text,
  ADD COLUMN resolved_at timestamptz,
  ADD COLUMN asset_symbol text,
  ADD COLUMN mint text,
  ADD COLUMN decimals smallint,
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  ADD CONSTRAINT hosted_payment_exceptions_assignment_shape CHECK (
    assigned_to IS NULL OR char_length(assigned_to) BETWEEN 1 AND 128
  );

UPDATE hosted_payment_exceptions AS exception
SET asset_symbol = CASE transfer.mint
      WHEN 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' THEN 'USDC'
      WHEN 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' THEN 'USDT'
      ELSE NULL
    END,
    mint = transfer.mint,
    decimals = transfer.decimals
FROM normalized_transfers AS transfer
WHERE transfer.chain_event_id = exception.chain_event_id
  AND transfer.parser_version = exception.parser_version;

ALTER TABLE hosted_payment_exceptions
  ALTER COLUMN mint SET NOT NULL,
  ALTER COLUMN decimals SET NOT NULL,
  ADD CONSTRAINT hosted_payment_exceptions_asset_shape CHECK (
    char_length(mint) BETWEEN 32 AND 64
    AND (
      asset_symbol IS NULL
      OR (asset_symbol = 'USDC'
        AND mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
      OR (asset_symbol = 'USDT'
        AND mint = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB')
    )
  ),
  ADD CONSTRAINT hosted_payment_exceptions_decimals CHECK (
    decimals BETWEEN 0 AND 18
  );

-- Extend the existing exception guard after adding transferred-asset evidence.
-- Workflow fields remain mutable through the store, while source evidence does not.
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
    OR OLD.asset_symbol IS DISTINCT FROM NEW.asset_symbol
    OR OLD.mint <> NEW.mint OR OLD.decimals <> NEW.decimals
    OR OLD.rule_code <> NEW.rule_code OR OLD.rule_version <> NEW.rule_version
    OR OLD.created_at <> NEW.created_at
  THEN
    RAISE EXCEPTION 'hosted exception evidence is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

-- Older releases could close an exception without retaining resolution metadata.
-- Preserve that historical uncertainty explicitly instead of inventing an operator.
UPDATE hosted_payment_exceptions
SET resolution_code = CASE
      WHEN review_state = 'ignored' THEN 'ignore'
      ELSE 'legacy_resolution_unknown'
    END,
    resolution_note =
      'Migrated from a pre-audit exception state; original resolution metadata is unavailable.',
    resolved_by = 'system:migration-4010',
    resolved_at = created_at
WHERE review_state IN ('resolved', 'ignored');

ALTER TABLE hosted_payment_exceptions
  ADD CONSTRAINT hosted_payment_exceptions_resolution_shape CHECK (
    (
      review_state IN ('open', 'assigned', 'investigating', 'escalated')
      AND resolution_code IS NULL AND resolution_note IS NULL
      AND resolved_by IS NULL AND resolved_at IS NULL
    ) OR (
      review_state IN ('resolved', 'ignored')
      AND resolution_code IS NOT NULL
      AND char_length(resolution_code) BETWEEN 1 AND 64
      AND resolution_note IS NOT NULL
      AND char_length(resolution_note) BETWEEN 1 AND 2000
      AND resolved_by IS NOT NULL
      AND char_length(resolved_by) BETWEEN 1 AND 128
      AND resolved_at IS NOT NULL
    )
  );

CREATE INDEX hosted_payment_exceptions_queue
  ON hosted_payment_exceptions(
    organization_id, review_state, created_at DESC, id DESC
  );

CREATE TABLE exception_case_events (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  exception_id uuid NOT NULL,
  sequence integer NOT NULL CHECK (sequence > 0),
  event_type text NOT NULL CHECK (
    event_type IN (
      'assigned', 'investigation_started', 'escalated', 'resolved',
      'ignored', 'reopened'
    )
  ),
  from_state text NOT NULL CHECK (
    from_state IN (
      'open', 'assigned', 'investigating', 'escalated', 'resolved', 'ignored'
    )
  ),
  to_state text NOT NULL CHECK (
    to_state IN (
      'open', 'assigned', 'investigating', 'escalated', 'resolved', 'ignored'
    )
  ),
  actor_id text NOT NULL CHECK (char_length(actor_id) BETWEEN 1 AND 128),
  reason_code text NOT NULL CHECK (char_length(reason_code) BETWEEN 1 AND 64),
  note text CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 2000),
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, exception_id, sequence),
  FOREIGN KEY (organization_id, exception_id)
    REFERENCES hosted_payment_exceptions(organization_id, id) ON DELETE RESTRICT
);

CREATE TABLE ledger_accounts (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  code text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,31}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 128),
  category text NOT NULL CHECK (
    category IN ('asset', 'liability', 'equity', 'revenue', 'expense', 'clearing')
  ),
  normal_balance text NOT NULL CHECK (normal_balance IN ('debit', 'credit')),
  system_account boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, code)
);

CREATE TABLE journal_entries (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  source_type text NOT NULL CHECK (
    source_type IN (
      'invoice_issued', 'invoice_cancelled', 'payment_received', 'unapplied_receipt',
      'cash_allocated', 'opening_balance', 'adjustment', 'refund_prepared'
    )
  ),
  source_id text NOT NULL CHECK (char_length(source_id) BETWEEN 1 AND 128),
  source_version integer NOT NULL DEFAULT 1 CHECK (source_version > 0),
  functional_currency text NOT NULL CHECK (
    functional_currency IN ('USD', 'EUR', 'GBP', 'INR')
  ),
  description text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 500),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  occurred_at timestamptz NOT NULL,
  posted_by text NOT NULL CHECK (char_length(posted_by) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, source_type, source_id, source_version)
);

CREATE TABLE journal_lines (
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  journal_entry_id uuid NOT NULL,
  line_number smallint NOT NULL CHECK (line_number BETWEEN 1 AND 100),
  account_id uuid NOT NULL,
  debit_minor_units numeric(38, 0) NOT NULL DEFAULT 0 CHECK (debit_minor_units >= 0),
  credit_minor_units numeric(38, 0) NOT NULL DEFAULT 0 CHECK (credit_minor_units >= 0),
  token_mint text,
  token_base_units numeric(20, 0),
  wallet_id uuid,
  chain_slot bigint,
  memo text CHECK (memo IS NULL OR char_length(memo) BETWEEN 1 AND 500),
  PRIMARY KEY (organization_id, journal_entry_id, line_number),
  FOREIGN KEY (organization_id, journal_entry_id)
    REFERENCES journal_entries(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, account_id)
    REFERENCES ledger_accounts(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, wallet_id)
    REFERENCES merchant_wallets(organization_id, id) ON DELETE RESTRICT,
  CHECK (
    (debit_minor_units > 0 AND credit_minor_units = 0)
    OR (credit_minor_units > 0 AND debit_minor_units = 0)
  ),
  CHECK ((token_mint IS NULL) = (token_base_units IS NULL)),
  CHECK ((wallet_id IS NULL) = (chain_slot IS NULL)),
  CHECK (chain_slot IS NULL OR chain_slot >= 0),
  CHECK (token_mint IS NULL OR char_length(token_mint) BETWEEN 32 AND 64),
  CHECK (
    token_base_units IS NULL
    OR token_base_units BETWEEN 1 AND 18446744073709551615
  )
);

CREATE INDEX journal_entries_order
  ON journal_entries(organization_id, occurred_at DESC, id DESC);
CREATE INDEX journal_lines_account
  ON journal_lines(organization_id, account_id, journal_entry_id);

CREATE TABLE ledger_reconciliations (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  wallet_id uuid NOT NULL,
  mint text NOT NULL CHECK (char_length(mint) BETWEEN 32 AND 64),
  comparison_slot bigint NOT NULL CHECK (comparison_slot >= 0),
  observed_base_units numeric(20, 0) NOT NULL CHECK (observed_base_units >= 0),
  ledger_base_units numeric(78, 0) NOT NULL,
  difference_base_units numeric(78, 0) NOT NULL,
  coverage_state text NOT NULL CHECK (coverage_state IN ('complete', 'incomplete')),
  balance_state text NOT NULL CHECK (balance_state IN ('matched', 'mismatch')),
  reason_code text NOT NULL CHECK (char_length(reason_code) BETWEEN 1 AND 64),
  reconciled_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, wallet_id, mint, comparison_slot),
  FOREIGN KEY (organization_id, wallet_id)
    REFERENCES merchant_wallets(organization_id, id) ON DELETE RESTRICT,
  CHECK (difference_base_units = observed_base_units - ledger_base_units),
  CHECK (
    (balance_state = 'matched' AND difference_base_units = 0)
    OR (balance_state = 'mismatch' AND difference_base_units <> 0)
  )
);

CREATE TABLE evidence_packs (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  invoice_id uuid NOT NULL,
  schema_version text NOT NULL CHECK (schema_version = '0.1'),
  manifest_bytes bytea NOT NULL CHECK (octet_length(manifest_bytes) BETWEEN 2 AND 10485760),
  pdf_bytes bytea NOT NULL CHECK (octet_length(pdf_bytes) BETWEEN 5 AND 10485760),
  manifest_digest text NOT NULL CHECK (manifest_digest ~ '^[0-9a-f]{64}$'),
  signature bytea NOT NULL CHECK (octet_length(signature) = 64),
  signing_key_id text NOT NULL CHECK (char_length(signing_key_id) BETWEEN 1 AND 128),
  public_key_pem text NOT NULL CHECK (char_length(public_key_pem) BETWEEN 80 AND 4096),
  generated_by text NOT NULL CHECK (char_length(generated_by) BETWEEN 1 AND 128),
  generated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, invoice_id)
    REFERENCES merchant_invoices(organization_id, id) ON DELETE RESTRICT
);

CREATE INDEX evidence_packs_invoice_order
  ON evidence_packs(organization_id, invoice_id, generated_at DESC, id DESC);

CREATE TABLE accounting_exports (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  format text NOT NULL CHECK (
    format IN (
      'payments_csv', 'invoices_csv', 'allocations_csv', 'journals_csv',
      'quickbooks_csv'
    )
  ),
  from_time timestamptz NOT NULL,
  through_time timestamptz NOT NULL,
  content_bytes bytea NOT NULL CHECK (octet_length(content_bytes) BETWEEN 1 AND 52428800),
  content_digest text NOT NULL CHECK (content_digest ~ '^[0-9a-f]{64}$'),
  row_count integer NOT NULL CHECK (row_count >= 0),
  generated_by text NOT NULL CHECK (char_length(generated_by) BETWEEN 1 AND 128),
  generated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  CHECK (through_time >= from_time)
);

CREATE INDEX accounting_exports_order
  ON accounting_exports(organization_id, generated_at DESC, id DESC);

CREATE OR REPLACE FUNCTION payops_reject_immutable_operation_record()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'operation record is append-only' USING ERRCODE = '23514';
END
$$;

CREATE TRIGGER exception_case_events_immutable
BEFORE UPDATE OR DELETE ON exception_case_events
FOR EACH ROW EXECUTE FUNCTION payops_reject_immutable_operation_record();
CREATE TRIGGER ledger_accounts_immutable
BEFORE UPDATE OR DELETE ON ledger_accounts
FOR EACH ROW EXECUTE FUNCTION payops_reject_immutable_operation_record();
CREATE TRIGGER journal_entries_immutable
BEFORE UPDATE OR DELETE ON journal_entries
FOR EACH ROW EXECUTE FUNCTION payops_reject_immutable_operation_record();
CREATE TRIGGER journal_lines_immutable
BEFORE UPDATE OR DELETE ON journal_lines
FOR EACH ROW EXECUTE FUNCTION payops_reject_immutable_operation_record();
CREATE TRIGGER ledger_reconciliations_immutable
BEFORE UPDATE OR DELETE ON ledger_reconciliations
FOR EACH ROW EXECUTE FUNCTION payops_reject_immutable_operation_record();
CREATE TRIGGER evidence_packs_immutable
BEFORE UPDATE OR DELETE ON evidence_packs
FOR EACH ROW EXECUTE FUNCTION payops_reject_immutable_operation_record();
CREATE TRIGGER accounting_exports_immutable
BEFORE UPDATE OR DELETE ON accounting_exports
FOR EACH ROW EXECUTE FUNCTION payops_reject_immutable_operation_record();

CREATE OR REPLACE FUNCTION payops_check_journal_balance()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_organization uuid;
  target_entry uuid;
  line_count integer;
  debit_total numeric(38, 0);
  credit_total numeric(38, 0);
  invalid_cash_provenance integer;
BEGIN
  IF TG_TABLE_NAME = 'journal_entries' THEN
    target_organization := NEW.organization_id;
    target_entry := NEW.id;
  ELSE
    target_organization := NEW.organization_id;
    target_entry := NEW.journal_entry_id;
  END IF;
  SELECT count(*), COALESCE(sum(debit_minor_units), 0),
    COALESCE(sum(credit_minor_units), 0)
  INTO line_count, debit_total, credit_total
  FROM journal_lines
  WHERE organization_id = target_organization
    AND journal_entry_id = target_entry;
  IF line_count < 2 OR debit_total <> credit_total THEN
    RAISE EXCEPTION 'journal entry must contain balanced lines'
      USING ERRCODE = '23514';
  END IF;
  SELECT count(*) INTO invalid_cash_provenance
  FROM journal_lines AS line
  JOIN ledger_accounts AS account
    ON account.organization_id = line.organization_id
    AND account.id = line.account_id
  WHERE line.organization_id = target_organization
    AND line.journal_entry_id = target_entry
    AND account.code IN ('CASH_USDC', 'CASH_USDT')
    AND (
      line.token_mint IS NULL
      OR line.token_base_units IS NULL
      OR line.wallet_id IS NULL
      OR line.chain_slot IS NULL
      OR (
        account.code = 'CASH_USDC'
        AND line.token_mint <> 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
      )
      OR (
        account.code = 'CASH_USDT'
        AND line.token_mint <> 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
      )
    );
  IF invalid_cash_provenance > 0 THEN
    RAISE EXCEPTION 'token cash lines require wallet and slot provenance'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE CONSTRAINT TRIGGER journal_entries_balanced
AFTER INSERT ON journal_entries
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION payops_check_journal_balance();
CREATE CONSTRAINT TRIGGER journal_lines_balanced
AFTER INSERT ON journal_lines
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION payops_check_journal_balance();

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'exception_case_events', 'ledger_accounts', 'journal_entries',
    'journal_lines', 'ledger_reconciliations', 'evidence_packs',
    'accounting_exports'
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
