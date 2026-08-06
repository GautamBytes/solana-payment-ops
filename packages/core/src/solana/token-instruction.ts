import bs58 from "bs58";

const TRANSFER_DISCRIMINATOR = 3;
const TRANSFER_CHECKED_DISCRIMINATOR = 12;
const TRANSFER_DATA_LENGTH = 9;
const TRANSFER_CHECKED_DATA_LENGTH = 10;

export type TokenInstructionDecode =
  | { readonly kind: "transfer"; readonly amountBaseUnits: bigint }
  | {
      readonly kind: "transferChecked";
      readonly amountBaseUnits: bigint;
      readonly decimals: number;
    }
  | { readonly kind: "unsupported"; readonly discriminator: number | null }
  | { readonly kind: "malformed"; readonly discriminator: number | null };

function readU64LittleEndian(bytes: Uint8Array, offset: number): bigint | null {
  let value = 0n;
  for (let index = 0; index < 8; index += 1) {
    const byte = bytes[offset + index];
    if (byte === undefined) return null;
    value |= BigInt(byte) << BigInt(index * 8);
  }
  return value;
}

export function decodeTokenInstruction(data: string): TokenInstructionDecode {
  let bytes: Uint8Array;
  try {
    bytes = bs58.decode(data);
  } catch {
    return { kind: "malformed", discriminator: null };
  }

  const discriminator = bytes[0] ?? null;
  if (discriminator === TRANSFER_DISCRIMINATOR) {
    if (bytes.length !== TRANSFER_DATA_LENGTH) {
      return { kind: "malformed", discriminator };
    }
    const amountBaseUnits = readU64LittleEndian(bytes, 1);
    return amountBaseUnits === null
      ? { kind: "malformed", discriminator }
      : { kind: "transfer", amountBaseUnits };
  }

  if (discriminator === TRANSFER_CHECKED_DISCRIMINATOR) {
    if (bytes.length !== TRANSFER_CHECKED_DATA_LENGTH) {
      return { kind: "malformed", discriminator };
    }
    const amountBaseUnits = readU64LittleEndian(bytes, 1);
    const decimals = bytes[9];
    return amountBaseUnits === null || decimals === undefined
      ? { kind: "malformed", discriminator }
      : { kind: "transferChecked", amountBaseUnits, decimals };
  }

  return { kind: "unsupported", discriminator };
}
