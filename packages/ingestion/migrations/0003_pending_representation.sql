ALTER TABLE discovered_signatures
  DROP CONSTRAINT IF EXISTS discovered_signatures_representation_class_check;

ALTER TABLE discovered_signatures
  ADD CONSTRAINT discovered_signatures_representation_class_check
  CHECK (
    representation_class IN (
      'pending',
      'parsed',
      'irrelevant',
      'failed_transaction',
      'quarantined'
    )
  );
