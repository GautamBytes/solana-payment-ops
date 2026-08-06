function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entryValue]) => [key, canonicalValue(entryValue)]),
    );
  }
  return value;
}

export function stringifyCanonical(value: unknown): string {
  return `${JSON.stringify(canonicalValue(value), null, 2)}\n`;
}
