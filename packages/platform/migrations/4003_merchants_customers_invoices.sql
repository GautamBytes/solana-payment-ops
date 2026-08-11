CREATE TABLE wallet_proof_challenges (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  address text NOT NULL,
  nonce_digest text NOT NULL CHECK (nonce_digest ~ '^[0-9a-f]{64}$'),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > issued_at)
);

CREATE UNIQUE INDEX wallet_proof_challenges_nonce_digest
  ON wallet_proof_challenges(nonce_digest);

CREATE TABLE merchant_wallets (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  address text NOT NULL,
  cluster text NOT NULL CHECK (cluster = 'mainnet-beta'),
  status text NOT NULL CHECK (status IN ('active', 'replaced')),
  verified_at timestamptz NOT NULL,
  replaced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id)
);

CREATE UNIQUE INDEX merchant_wallets_active_organization
  ON merchant_wallets(organization_id) WHERE status = 'active';
CREATE UNIQUE INDEX merchant_wallets_active_address
  ON merchant_wallets(address) WHERE status = 'active';

CREATE TABLE merchant_wallet_assets (
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  wallet_id uuid NOT NULL,
  symbol text NOT NULL CHECK (symbol IN ('USDC', 'USDT')),
  mint text NOT NULL,
  token_account text NOT NULL,
  decimals smallint NOT NULL CHECK (decimals = 6),
  token_program text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, wallet_id, symbol),
  FOREIGN KEY (organization_id, wallet_id)
    REFERENCES merchant_wallets(organization_id, id) ON DELETE RESTRICT
);

CREATE TABLE wallet_replacement_requests (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  wallet_id uuid NOT NULL,
  replacement_address text NOT NULL,
  accepted_asset_symbols text[] NOT NULL,
  requested_by text NOT NULL,
  requested_at timestamptz NOT NULL,
  activates_at timestamptz NOT NULL,
  activated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, wallet_id)
    REFERENCES merchant_wallets(organization_id, id) ON DELETE RESTRICT,
  CHECK (activates_at = requested_at + interval '24 hours')
);

CREATE UNIQUE INDEX wallet_replacements_pending_wallet
  ON wallet_replacement_requests(organization_id, wallet_id)
  WHERE activated_at IS NULL;

CREATE TABLE customers (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  external_id text,
  display_name text NOT NULL,
  email text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id)
);

CREATE UNIQUE INDEX customers_external_identity
  ON customers(organization_id, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX customers_created_order
  ON customers(organization_id, created_at DESC, id DESC);

CREATE TABLE merchant_invoices (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  public_reference text NOT NULL,
  external_id text,
  customer_id uuid NOT NULL,
  settlement_wallet_id uuid NOT NULL,
  accepted_asset_symbols text[] NOT NULL CHECK (
    accepted_asset_symbols IN (
      ARRAY['USDC']::text[], ARRAY['USDT']::text[],
      ARRAY['USDC', 'USDT']::text[]
    )
  ),
  currency text NOT NULL CHECK (currency IN ('USD', 'EUR', 'GBP', 'INR')),
  status text NOT NULL CHECK (status IN ('draft', 'issued', 'cancelled')),
  subtotal_minor_units numeric(38, 0) NOT NULL CHECK (subtotal_minor_units >= 0),
  tax_minor_units numeric(38, 0) NOT NULL CHECK (tax_minor_units >= 0),
  total_minor_units numeric(38, 0) NOT NULL CHECK (total_minor_units >= 0),
  due_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  issued_at timestamptz,
  cancelled_at timestamptz,
  cancellation_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, public_reference),
  FOREIGN KEY (organization_id, customer_id)
    REFERENCES customers(organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, settlement_wallet_id)
    REFERENCES merchant_wallets(organization_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX merchant_invoices_external_identity
  ON merchant_invoices(organization_id, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX merchant_invoices_created_order
  ON merchant_invoices(organization_id, created_at DESC, id DESC);

CREATE TABLE merchant_invoice_lines (
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  invoice_id uuid NOT NULL,
  position smallint NOT NULL CHECK (position BETWEEN 1 AND 100),
  description text NOT NULL,
  quantity text NOT NULL CHECK (
    quantity ~ '^(0|[1-9][0-9]{0,37})(\.[0-9]{1,6})?$'
  ),
  unit_price_minor_units numeric(38, 0) NOT NULL CHECK (unit_price_minor_units >= 0),
  tax_label text,
  tax_minor_units numeric(38, 0) NOT NULL CHECK (tax_minor_units >= 0),
  line_subtotal_minor_units numeric(38, 0) NOT NULL CHECK (line_subtotal_minor_units >= 0),
  PRIMARY KEY (organization_id, invoice_id, position),
  FOREIGN KEY (organization_id, invoice_id)
    REFERENCES merchant_invoices(organization_id, id) ON DELETE RESTRICT
);

CREATE TABLE merchant_invoice_issued_snapshots (
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  invoice_id uuid NOT NULL,
  invoice_version integer NOT NULL CHECK (invoice_version > 0),
  canonical_payload text NOT NULL,
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, invoice_id),
  FOREIGN KEY (organization_id, invoice_id)
    REFERENCES merchant_invoices(organization_id, id) ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION payops_immutable_invoice_snapshot()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'invoice snapshots are immutable' USING ERRCODE = '23514';
END
$$;

CREATE TRIGGER merchant_invoice_snapshots_immutable
BEFORE UPDATE OR DELETE ON merchant_invoice_issued_snapshots
FOR EACH ROW EXECUTE FUNCTION payops_immutable_invoice_snapshot();

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'wallet_proof_challenges', 'merchant_wallets', 'merchant_wallet_assets',
    'wallet_replacement_requests', 'customers', 'merchant_invoices',
    'merchant_invoice_lines', 'merchant_invoice_issued_snapshots'
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
