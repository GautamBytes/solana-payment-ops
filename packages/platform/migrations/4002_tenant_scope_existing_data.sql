CREATE OR REPLACE FUNCTION payops_current_organization_id()
RETURNS uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN current_setting('payops.organization_id', true) ~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    THEN current_setting('payops.organization_id', true)::uuid
    ELSE NULL
  END
$$;

ALTER TABLE watch_targets
  ADD COLUMN organization_id uuid;
UPDATE watch_targets
SET organization_id = '00000000-0000-4000-8000-000000000001'
WHERE organization_id IS NULL;
ALTER TABLE watch_targets
  ALTER COLUMN organization_id SET NOT NULL,
  ALTER COLUMN organization_id SET DEFAULT payops_current_organization_id(),
  ADD CONSTRAINT watch_targets_organization_fk
    FOREIGN KEY (organization_id) REFERENCES organization(id) ON DELETE RESTRICT;

DROP INDEX watch_targets_active_identity;
CREATE UNIQUE INDEX watch_targets_active_identity
  ON watch_targets(organization_id, provider_id, cluster, address)
  WHERE active;

ALTER TABLE reconciliation_invoices
  ADD COLUMN organization_id uuid;
UPDATE reconciliation_invoices
SET organization_id = '00000000-0000-4000-8000-000000000001'
WHERE organization_id IS NULL;
ALTER TABLE reconciliation_invoices
  ALTER COLUMN organization_id SET NOT NULL,
  ALTER COLUMN organization_id SET DEFAULT payops_current_organization_id(),
  ADD CONSTRAINT reconciliation_invoices_organization_fk
    FOREIGN KEY (organization_id) REFERENCES organization(id) ON DELETE RESTRICT;
ALTER TABLE reconciliation_invoices
  DROP CONSTRAINT reconciliation_invoices_reference_address_key;
CREATE UNIQUE INDEX reconciliation_invoices_reference_identity
  ON reconciliation_invoices(organization_id, reference_address);

ALTER TABLE reconciliation_runs
  ADD COLUMN organization_id uuid;
UPDATE reconciliation_runs
SET organization_id = '00000000-0000-4000-8000-000000000001'
WHERE organization_id IS NULL;
ALTER TABLE reconciliation_runs
  ALTER COLUMN organization_id SET NOT NULL,
  ALTER COLUMN organization_id SET DEFAULT payops_current_organization_id(),
  ADD CONSTRAINT reconciliation_runs_organization_fk
    FOREIGN KEY (organization_id) REFERENCES organization(id) ON DELETE RESTRICT;

ALTER TABLE webhook_endpoints
  ADD COLUMN organization_id uuid;
UPDATE webhook_endpoints
SET organization_id = '00000000-0000-4000-8000-000000000001'
WHERE organization_id IS NULL;
ALTER TABLE webhook_endpoints
  ALTER COLUMN organization_id SET NOT NULL,
  ALTER COLUMN organization_id SET DEFAULT payops_current_organization_id(),
  ADD CONSTRAINT webhook_endpoints_organization_fk
    FOREIGN KEY (organization_id) REFERENCES organization(id) ON DELETE RESTRICT;

ALTER TABLE webhook_events
  ADD COLUMN organization_id uuid;
ALTER TABLE webhook_events DISABLE TRIGGER webhook_events_immutable;
UPDATE webhook_events
SET organization_id = '00000000-0000-4000-8000-000000000001'
WHERE organization_id IS NULL;
ALTER TABLE webhook_events ENABLE TRIGGER webhook_events_immutable;
ALTER TABLE webhook_events
  ALTER COLUMN organization_id SET NOT NULL,
  ALTER COLUMN organization_id SET DEFAULT payops_current_organization_id(),
  ADD CONSTRAINT webhook_events_organization_fk
    FOREIGN KEY (organization_id) REFERENCES organization(id) ON DELETE RESTRICT;
DO $$
DECLARE
  source_identity_constraint text;
BEGIN
  SELECT constraint_name
  INTO source_identity_constraint
  FROM information_schema.table_constraints
  WHERE table_schema = current_schema()
    AND table_name = 'webhook_events'
    AND constraint_type = 'UNIQUE'
  ORDER BY constraint_name
  LIMIT 1;

  IF source_identity_constraint IS NULL THEN
    RAISE EXCEPTION 'webhook event source identity constraint is missing';
  END IF;

  EXECUTE format(
    'ALTER TABLE webhook_events DROP CONSTRAINT %I',
    source_identity_constraint
  );
END
$$;
ALTER TABLE webhook_events
  ADD CONSTRAINT webhook_events_source_identity
  UNIQUE (organization_id, event_type, source_type, source_id, source_version);

ALTER TABLE watch_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE watch_targets FORCE ROW LEVEL SECURITY;
CREATE POLICY watch_targets_tenant_policy ON watch_targets
  USING (organization_id = payops_current_organization_id())
  WITH CHECK (organization_id = payops_current_organization_id());

ALTER TABLE reconciliation_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconciliation_invoices FORCE ROW LEVEL SECURITY;
CREATE POLICY reconciliation_invoices_tenant_policy ON reconciliation_invoices
  USING (organization_id = payops_current_organization_id())
  WITH CHECK (organization_id = payops_current_organization_id());

ALTER TABLE reconciliation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconciliation_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY reconciliation_runs_tenant_policy ON reconciliation_runs
  USING (organization_id = payops_current_organization_id())
  WITH CHECK (organization_id = payops_current_organization_id());

ALTER TABLE webhook_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_endpoints FORCE ROW LEVEL SECURITY;
CREATE POLICY webhook_endpoints_tenant_policy ON webhook_endpoints
  USING (organization_id = payops_current_organization_id())
  WITH CHECK (organization_id = payops_current_organization_id());

ALTER TABLE webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_events FORCE ROW LEVEL SECURITY;
CREATE POLICY webhook_events_tenant_policy ON webhook_events
  USING (organization_id = payops_current_organization_id())
  WITH CHECK (organization_id = payops_current_organization_id());
