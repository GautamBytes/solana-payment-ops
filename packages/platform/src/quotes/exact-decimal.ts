const unsignedDecimalPattern = /^(0|[1-9][0-9]{0,37})(\.[0-9]{1,18})?$/;
const signedIntegerPattern = /^-?(0|[1-9][0-9]{0,18})$/;
const unsignedIntegerPattern = /^(0|[1-9][0-9]{0,19})$/;

export interface ExactDecimal {
  readonly coefficient: bigint;
  readonly scale: number;
}

export function parseUnsignedDecimal(
  value: string,
  allowZero: boolean,
): ExactDecimal {
  if (!unsignedDecimalPattern.test(value)) throw new Error("invalid_decimal");
  const [integer, fraction = ""] = value.split(".");
  const decimal = normalize({
    coefficient: BigInt(`${integer}${fraction}`),
    scale: fraction.length,
  });
  if (!allowZero && decimal.coefficient === 0n)
    throw new Error("invalid_decimal");
  return decimal;
}

export function decimalFromIntegerExponent(
  integer: string,
  exponent: number,
  allowZero: boolean,
): string {
  const pattern = allowZero ? unsignedIntegerPattern : signedIntegerPattern;
  if (
    !pattern.test(integer) ||
    !Number.isSafeInteger(exponent) ||
    exponent < -18 ||
    exponent > 18
  ) {
    throw new Error("invalid_decimal");
  }
  const coefficient = BigInt(integer);
  if (coefficient < 0n || (!allowZero && coefficient === 0n)) {
    throw new Error("invalid_decimal");
  }
  return formatDecimal(
    exponent >= 0
      ? { coefficient: coefficient * 10n ** BigInt(exponent), scale: 0 }
      : { coefficient, scale: -exponent },
  );
}

export function compareDecimal(
  left: ExactDecimal,
  right: ExactDecimal,
): -1 | 0 | 1 {
  const scale = Math.max(left.scale, right.scale);
  const leftValue = left.coefficient * 10n ** BigInt(scale - left.scale);
  const rightValue = right.coefficient * 10n ** BigInt(scale - right.scale);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

export function ratioAtMost(
  numerator: ExactDecimal,
  denominator: ExactDecimal,
  maximumNumerator: bigint,
  maximumDenominator: bigint,
): boolean {
  if (denominator.coefficient <= 0n) return false;
  const commonScale = Math.max(numerator.scale, denominator.scale);
  const numeratorValue =
    numerator.coefficient * 10n ** BigInt(commonScale - numerator.scale);
  const denominatorValue =
    denominator.coefficient * 10n ** BigInt(commonScale - denominator.scale);
  return (
    numeratorValue * maximumDenominator <= denominatorValue * maximumNumerator
  );
}

export function absoluteDifference(
  left: ExactDecimal,
  right: ExactDecimal,
): ExactDecimal {
  const scale = Math.max(left.scale, right.scale);
  const leftValue = left.coefficient * 10n ** BigInt(scale - left.scale);
  const rightValue = right.coefficient * 10n ** BigInt(scale - right.scale);
  return normalize({
    coefficient:
      leftValue >= rightValue ? leftValue - rightValue : rightValue - leftValue,
    scale,
  });
}

export function formatDecimal(value: ExactDecimal): string {
  const normalized = normalize(value);
  const digits = normalized.coefficient.toString();
  if (normalized.scale === 0) return digits;
  const padded = digits.padStart(normalized.scale + 1, "0");
  return `${padded.slice(0, -normalized.scale)}.${padded.slice(-normalized.scale)}`;
}

function normalize(value: ExactDecimal): ExactDecimal {
  let coefficient = value.coefficient;
  let scale = value.scale;
  while (scale > 0 && coefficient % 10n === 0n) {
    coefficient /= 10n;
    scale -= 1;
  }
  return { coefficient, scale };
}
