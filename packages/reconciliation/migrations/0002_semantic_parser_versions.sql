CREATE OR REPLACE FUNCTION payops_semver_key(parser_version text)
RETURNS numeric[]
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN parser_version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
      THEN ARRAY[
        split_part(parser_version, '.', 1)::numeric,
        split_part(parser_version, '.', 2)::numeric,
        split_part(parser_version, '.', 3)::numeric
      ]
    ELSE NULL
  END
$$;
