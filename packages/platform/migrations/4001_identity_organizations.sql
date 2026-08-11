CREATE TABLE "user" (
  id text PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  email_verified boolean NOT NULL DEFAULT false,
  image text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  two_factor_enabled boolean DEFAULT false
);

CREATE TABLE "session" (
  id text PRIMARY KEY,
  expires_at timestamp NOT NULL,
  token text NOT NULL UNIQUE,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL,
  ip_address text,
  user_agent text,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  active_organization_id uuid
);

CREATE INDEX session_userId_idx ON "session"(user_id);

CREATE TABLE account (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  provider_id text NOT NULL,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  access_token text,
  refresh_token text,
  id_token text,
  access_token_expires_at timestamp,
  refresh_token_expires_at timestamp,
  scope text,
  password text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL
);

CREATE INDEX account_userId_idx ON account(user_id);

CREATE TABLE verification (
  id text PRIMARY KEY,
  identifier text NOT NULL,
  value text NOT NULL,
  expires_at timestamp NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX verification_identifier_idx ON verification(identifier);

CREATE TABLE organization (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  logo text,
  created_at timestamp NOT NULL,
  metadata text
);

ALTER TABLE "session"
  ADD CONSTRAINT session_active_organization_fk
  FOREIGN KEY (active_organization_id) REFERENCES organization(id)
  ON DELETE SET NULL;

INSERT INTO organization (id, name, slug, created_at, metadata)
VALUES (
  '00000000-0000-4000-8000-000000000001',
  'PayOps Self-Hosted',
  'payops-self-hosted',
  now(),
  '{"kind":"self_hosted_default"}'
);

CREATE TABLE member (
  id text PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'viewer' CHECK (
    role IN ('owner', 'operator', 'developer', 'accountant', 'viewer')
  ),
  created_at timestamp NOT NULL,
  UNIQUE (organization_id, user_id)
);

CREATE INDEX member_organizationId_idx ON member(organization_id);
CREATE INDEX member_userId_idx ON member(user_id);

CREATE TABLE invitation (
  id text PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  email text NOT NULL,
  role text CHECK (
    role IS NULL OR role IN ('owner', 'operator', 'developer', 'accountant', 'viewer')
  ),
  status text NOT NULL DEFAULT 'pending',
  expires_at timestamp NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  inviter_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
);

CREATE INDEX invitation_organizationId_idx ON invitation(organization_id);
CREATE INDEX invitation_email_idx ON invitation(email);

CREATE TABLE two_factor (
  id text PRIMARY KEY,
  secret text NOT NULL,
  backup_codes text NOT NULL,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  verified boolean DEFAULT true,
  failed_verification_count integer DEFAULT 0,
  locked_until timestamp
);

CREATE INDEX twoFactor_secret_idx ON two_factor(secret);
CREATE INDEX twoFactor_userId_idx ON two_factor(user_id);

CREATE TABLE apikey (
  id text PRIMARY KEY,
  config_id text NOT NULL DEFAULT 'default',
  name text,
  start text,
  reference_id uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  prefix text,
  key text NOT NULL,
  refill_interval integer,
  refill_amount integer,
  last_refill_at timestamp,
  enabled boolean DEFAULT true,
  rate_limit_enabled boolean DEFAULT true,
  rate_limit_time_window integer DEFAULT 86400000,
  rate_limit_max integer DEFAULT 10,
  request_count integer DEFAULT 0,
  remaining integer,
  last_request timestamp,
  expires_at timestamp,
  created_at timestamp NOT NULL,
  updated_at timestamp NOT NULL,
  permissions text,
  metadata text
);

CREATE INDEX apikey_configId_idx ON apikey(config_id);
CREATE INDEX apikey_referenceId_idx ON apikey(reference_id);
CREATE INDEX apikey_key_idx ON apikey(key);

CREATE TABLE rate_limit (
  id text PRIMARY KEY,
  key text NOT NULL UNIQUE,
  count integer NOT NULL,
  last_request bigint NOT NULL
);

CREATE TABLE platform_bootstrap_invitations (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  normalized_email text NOT NULL,
  token_digest text NOT NULL UNIQUE CHECK (token_digest ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL,
  CHECK (consumed_at IS NULL OR consumed_at >= created_at)
);

CREATE UNIQUE INDEX platform_bootstrap_invitations_pending_identity
  ON platform_bootstrap_invitations(organization_id)
  WHERE consumed_at IS NULL;

CREATE OR REPLACE FUNCTION payops_protect_last_owner()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.role = 'owner'
    AND (TG_OP = 'DELETE' OR NEW.role <> 'owner')
  THEN
    PERFORM 1 FROM organization WHERE id = OLD.organization_id FOR UPDATE;
    IF NOT EXISTS (
      SELECT 1 FROM member
      WHERE organization_id = OLD.organization_id
        AND role = 'owner'
        AND id <> OLD.id
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'organization must retain one owner';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;

CREATE TRIGGER member_protect_last_owner
BEFORE DELETE OR UPDATE OF role ON member
FOR EACH ROW EXECUTE FUNCTION payops_protect_last_owner();
