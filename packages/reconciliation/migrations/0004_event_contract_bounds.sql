DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM reconciliation_invoices
    WHERE char_length(invoice_id) NOT BETWEEN 1 AND 128
       OR char_length(customer_id) NOT BETWEEN 1 AND 512
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'reconciliation invoice identity exceeds webhook event contract bounds',
      HINT = 'Shorten invoice_id to 128 and customer_id to 512 characters before retrying migration 1004.';
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'reconciliation_invoices'::regclass
      AND conname = 'reconciliation_invoices_invoice_id_event_bound'
  ) THEN
    ALTER TABLE reconciliation_invoices
      ADD CONSTRAINT reconciliation_invoices_invoice_id_event_bound
      CHECK (char_length(invoice_id) BETWEEN 1 AND 128);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'reconciliation_invoices'::regclass
      AND conname = 'reconciliation_invoices_customer_id_event_bound'
  ) THEN
    ALTER TABLE reconciliation_invoices
      ADD CONSTRAINT reconciliation_invoices_customer_id_event_bound
      CHECK (char_length(customer_id) BETWEEN 1 AND 512);
  END IF;
END;
$$;
