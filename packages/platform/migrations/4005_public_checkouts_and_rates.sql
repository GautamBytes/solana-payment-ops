CREATE TABLE public_checkouts (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  invoice_id uuid NOT NULL,
  public_nonce bytea NOT NULL CHECK (octet_length(public_nonce) = 32),
  derivation_key_id text NOT NULL CHECK (
    derivation_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  ),
  state text NOT NULL CHECK (state IN ('active', 'revoked')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, invoice_id)
    REFERENCES merchant_invoices(organization_id, id) ON DELETE RESTRICT,
  CHECK (
    (state = 'active' AND revoked_at IS NULL)
    OR (state = 'revoked' AND revoked_at IS NOT NULL AND revoked_at >= created_at)
  )
);

CREATE UNIQUE INDEX public_checkouts_active_invoice
  ON public_checkouts(organization_id, invoice_id)
  WHERE state = 'active';
CREATE INDEX public_checkouts_invoice_lookup
  ON public_checkouts(organization_id, invoice_id, created_at DESC);

-- This digest-only directory is intentionally not tenant-readable through RLS:
-- it resolves an unguessable bearer digest to the tenant transaction that owns it.
CREATE TABLE public_checkout_capabilities (
  token_digest text PRIMARY KEY CHECK (token_digest ~ '^[0-9a-f]{64}$'),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  checkout_id uuid NOT NULL UNIQUE,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL,
  revoked_at timestamptz,
  FOREIGN KEY (organization_id, checkout_id)
    REFERENCES public_checkouts(organization_id, id) ON DELETE RESTRICT,
  CHECK (
    (active AND revoked_at IS NULL)
    OR (NOT active AND revoked_at IS NOT NULL AND revoked_at >= created_at)
  )
);

CREATE TABLE quote_rate_observations (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  observation_kind text NOT NULL CHECK (
    observation_kind IN ('stablecoin', 'fiat')
  ),
  source text NOT NULL CHECK (
    source IN (
      'pyth_hermes', 'secondary_test', 'secondary_commercial', 'ecb_reference'
    )
  ),
  symbol text,
  price text,
  confidence text,
  exponent smallint,
  publish_time timestamptz,
  received_at timestamptz NOT NULL,
  feed_id text,
  base_currency text,
  rates jsonb,
  observed_for date,
  published_at timestamptz,
  usage text,
  raw_response_digest text NOT NULL CHECK (
    raw_response_digest ~ '^[0-9a-f]{64}$'
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  CHECK (
    observation_kind <> 'stablecoin'
    OR (
      source IN ('pyth_hermes', 'secondary_test', 'secondary_commercial')
      AND symbol IN ('USDC', 'USDT')
      AND price ~ '^(0|[1-9][0-9]{0,37})(\.[0-9]{1,18})?$'
      AND price::numeric > 0
      AND confidence ~ '^(0|[1-9][0-9]{0,37})(\.[0-9]{1,18})?$'
      AND confidence::numeric >= 0
      AND exponent BETWEEN -18 AND 18
      AND publish_time IS NOT NULL
      AND feed_id IS NOT NULL AND char_length(feed_id) BETWEEN 1 AND 128
      AND base_currency IS NULL AND rates IS NULL AND observed_for IS NULL
      AND published_at IS NULL AND usage IS NULL
    )
  ),
  CHECK (
    observation_kind <> 'fiat'
    OR (
      source IN ('ecb_reference', 'secondary_commercial')
      AND symbol IS NULL AND price IS NULL AND confidence IS NULL
      AND exponent IS NULL AND publish_time IS NULL AND feed_id IS NULL
      AND base_currency = 'EUR'
      AND jsonb_typeof(rates) = 'object'
      AND observed_for IS NOT NULL AND published_at IS NOT NULL
      AND usage IN ('reference_only', 'production_live')
      AND (
        (source = 'ecb_reference' AND usage = 'reference_only')
        OR (source = 'secondary_commercial' AND usage = 'production_live')
      )
    )
  )
);

CREATE INDEX quote_rate_observations_stablecoin_latest
  ON quote_rate_observations(organization_id, symbol, publish_time DESC, id DESC)
  WHERE observation_kind = 'stablecoin';
CREATE INDEX quote_rate_observations_fiat_latest
  ON quote_rate_observations(organization_id, observed_for DESC, id DESC)
  WHERE observation_kind = 'fiat';

CREATE OR REPLACE FUNCTION payops_immutable_rate_observation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'rate observations are immutable' USING ERRCODE = '23514';
END
$$;

CREATE TRIGGER quote_rate_observations_immutable
BEFORE UPDATE OR DELETE ON quote_rate_observations
FOR EACH ROW EXECUTE FUNCTION payops_immutable_rate_observation();

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'public_checkouts', 'quote_rate_observations'
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
