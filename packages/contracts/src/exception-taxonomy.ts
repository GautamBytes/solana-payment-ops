export const EXCEPTION_CODES = [
  "missing_reference",
  "unknown_reference",
  "ambiguous_reference",
  "duplicate_payment",
  "wrong_asset",
  "wrong_destination",
  "missing_block_time",
  "before_issue",
  "late_payment",
  "partial_payment",
  "excess_payment",
] as const;

export type ExceptionCode = (typeof EXCEPTION_CODES)[number];
