ALTER TABLE payment_attempts
  ADD COLUMN idempotency_key text,
  ADD COLUMN payment_url text;

ALTER TABLE payment_attempts
  ADD CONSTRAINT payment_attempts_idempotency_key_format CHECK (
    idempotency_key IS NULL OR (
      char_length(idempotency_key) BETWEEN 16 AND 128
      AND idempotency_key ~ '^[!-~]+$'
    )
  ),
  ADD CONSTRAINT payment_attempts_payment_url_format CHECK (
    payment_url IS NULL OR (
      char_length(payment_url) BETWEEN 1 AND 2048
      AND payment_url LIKE 'solana:%'
    )
  ),
  ADD CONSTRAINT payment_attempts_idempotency_pair CHECK (
    (idempotency_key IS NULL) = (payment_url IS NULL)
  );

CREATE UNIQUE INDEX payment_attempts_checkout_idempotency
  ON payment_attempts(organization_id, checkout_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
