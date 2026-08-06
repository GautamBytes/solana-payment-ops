ALTER TABLE discovered_signatures
  ADD COLUMN IF NOT EXISTS finality_claim_token uuid;
