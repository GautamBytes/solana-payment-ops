DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM normalized_transfers
    WHERE parser_version !~ '^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$'
  ) THEN
    RAISE EXCEPTION USING
      MESSAGE = 'Cannot enforce bounded parser versions: normalized_transfers contains invalid parser_version values',
      HINT = 'Rewrite every parser_version as MAJOR.MINOR.PATCH with each component from 0 to 999999999 and no leading zeroes, then rerun migrations.';
  END IF;
END
$migration$;

ALTER TABLE normalized_transfers
  DROP CONSTRAINT IF EXISTS normalized_transfers_parser_version_check;

ALTER TABLE normalized_transfers
  ADD CONSTRAINT normalized_transfers_parser_version_check
  CHECK (
    parser_version ~ '^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$'
  );

CREATE OR REPLACE FUNCTION payops_semver_key(parser_version text)
RETURNS numeric[]
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN parser_version ~ '^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$'
      THEN ARRAY[
        split_part(parser_version, '.', 1)::numeric,
        split_part(parser_version, '.', 2)::numeric,
        split_part(parser_version, '.', 3)::numeric
      ]
    ELSE NULL
  END
$$;
