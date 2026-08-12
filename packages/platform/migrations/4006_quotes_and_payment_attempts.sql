CREATE TABLE payment_attempts (
  id uuid PRIMARY KEY,
  public_attempt_id uuid NOT NULL UNIQUE,
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  invoice_id uuid NOT NULL,
  checkout_id uuid NOT NULL,
  asset_symbol text NOT NULL CHECK (asset_symbol IN ('USDC', 'USDT')),
  reference_address text NOT NULL UNIQUE CHECK (
    char_length(reference_address) BETWEEN 32 AND 64
  ),
  recipient_address text NOT NULL CHECK (
    char_length(recipient_address) BETWEEN 32 AND 64
  ),
  mint text NOT NULL CHECK (char_length(mint) BETWEEN 32 AND 64),
  recipient_token_account text NOT NULL CHECK (
    char_length(recipient_token_account) BETWEEN 32 AND 64
  ),
  state text NOT NULL CHECK (
    state IN (
      'created', 'quoted', 'awaiting_payment', 'detected', 'confirmed',
      'finalized', 'expired', 'confirmation_revoked', 'allocated', 'exception'
    )
  ),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, public_attempt_id),
  FOREIGN KEY (organization_id, invoice_id)
    REFERENCES merchant_invoices(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, checkout_id)
    REFERENCES public_checkouts(organization_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX payment_attempts_active_asset
  ON payment_attempts(organization_id, invoice_id, asset_symbol)
  WHERE state IN (
    'created', 'quoted', 'awaiting_payment', 'detected', 'confirmed',
    'finalized', 'confirmation_revoked'
  );
CREATE INDEX payment_attempts_checkout_order
  ON payment_attempts(organization_id, checkout_id, created_at DESC, id DESC);

CREATE TABLE payment_quotes (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  attempt_id uuid NOT NULL,
  stablecoin_observation_id uuid NOT NULL,
  fiat_observation_id uuid,
  formula_version text NOT NULL CHECK (formula_version = 'quote-v1'),
  invoice_currency text NOT NULL CHECK (
    invoice_currency IN ('USD', 'EUR', 'GBP', 'INR')
  ),
  invoice_minor_units numeric(38, 0) NOT NULL CHECK (invoice_minor_units > 0),
  fiat_amount text NOT NULL CHECK (
    fiat_amount ~ '^(0|[1-9][0-9]{0,37})(\.[0-9]{1,128})?$'
    AND fiat_amount::numeric > 0
  ),
  usd_amount text NOT NULL CHECK (
    usd_amount ~ '^(0|[1-9][0-9]{0,37})(\.[0-9]{1,128})?$'
    AND usd_amount::numeric > 0
  ),
  stablecoin_usd_price text NOT NULL CHECK (
    stablecoin_usd_price ~ '^(0|[1-9][0-9]{0,37})(\.[0-9]{1,128})?$'
    AND stablecoin_usd_price::numeric > 0
  ),
  token_amount text NOT NULL CHECK (
    token_amount ~ '^(0|[1-9][0-9]{0,37})(\.[0-9]{1,128})?$'
    AND token_amount::numeric > 0
  ),
  amount_base_units numeric(20, 0) NOT NULL CHECK (
    amount_base_units BETWEEN 1 AND 18446744073709551615
  ),
  amount_tokens text NOT NULL CHECK (
    amount_tokens ~ '^(0|[1-9][0-9]{0,19})(\.[0-9]{1,6})?$'
    AND amount_tokens::numeric > 0
  ),
  input_digest text NOT NULL CHECK (input_digest ~ '^[0-9a-f]{64}$'),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  issuance_slot numeric(20, 0) NOT NULL CHECK (
    issuance_slot BETWEEN 0 AND 18446744073709551615
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, attempt_id),
  FOREIGN KEY (organization_id, attempt_id)
    REFERENCES payment_attempts(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, stablecoin_observation_id)
    REFERENCES quote_rate_observations(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, fiat_observation_id)
    REFERENCES quote_rate_observations(organization_id, id) ON DELETE RESTRICT,
  CHECK (expires_at = issued_at + interval '15 minutes')
);

CREATE INDEX payment_quotes_expiry
  ON payment_quotes(organization_id, expires_at, id);

CREATE OR REPLACE FUNCTION payops_immutable_payment_quote()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'payment quotes are immutable' USING ERRCODE = '23514';
END
$$;

CREATE TRIGGER payment_quotes_immutable
BEFORE UPDATE OR DELETE ON payment_quotes
FOR EACH ROW EXECUTE FUNCTION payops_immutable_payment_quote();

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'payment_attempts', 'payment_quotes'
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
