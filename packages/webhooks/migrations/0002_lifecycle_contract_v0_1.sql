ALTER TABLE webhook_events
  DROP CONSTRAINT IF EXISTS webhook_events_event_type_check;

ALTER TABLE webhook_events
  DROP CONSTRAINT IF EXISTS webhook_events_check;

ALTER TABLE webhook_events
  DROP CONSTRAINT IF EXISTS payops_webhook_events_event_type_v0_1;

ALTER TABLE webhook_events
  DROP CONSTRAINT IF EXISTS payops_webhook_events_source_pair_v0_1;

ALTER TABLE webhook_events
  ADD CONSTRAINT payops_webhook_events_event_type_v0_1 CHECK (
    event_type IN (
      'invoice.issued',
      'invoice.cancelled',
      'payment.detected',
      'payment.confirmed',
      'payment.finalized',
      'payment.confirmation_revoked',
      'payment.exception_created',
      'invoice.partial',
      'invoice.paid',
      'invoice.overpaid',
      'refund.prepared',
      'refund.finalized',
      'evidence.ready'
    )
  );

ALTER TABLE webhook_events
  ADD CONSTRAINT payops_webhook_events_source_pair_v0_1 CHECK (
    (event_type IN (
      'invoice.issued',
      'invoice.cancelled',
      'invoice.partial',
      'invoice.paid',
      'invoice.overpaid'
    ) AND source_type = 'invoice')
    OR (event_type IN (
      'payment.detected',
      'payment.confirmed',
      'payment.finalized',
      'payment.confirmation_revoked'
    ) AND source_type = 'payment')
    OR (
      event_type = 'payment.exception_created'
      AND source_type = 'payment_exception'
    )
    OR (event_type IN (
      'refund.prepared',
      'refund.finalized'
    ) AND source_type = 'refund')
    OR (event_type = 'evidence.ready' AND source_type = 'evidence_pack')
  );
