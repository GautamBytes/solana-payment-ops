export function unicodeCodePointLength(value: string): number {
  let length = 0;
  for (const _codePoint of value) length += 1;
  return length;
}
