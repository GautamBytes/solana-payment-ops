import bs58 from "bs58";
import type { DecodedTransferChecked } from "../domain/types.js";

const TRANSFER_CHECKED_DISCRIMINATOR = 12;
const TRANSFER_CHECKED_DATA_LENGTH = 10;

export function decodeTransferChecked(data: string): DecodedTransferChecked {
  const bytes = bs58.decode(data);

  if (bytes[0] !== TRANSFER_CHECKED_DISCRIMINATOR) {
    throw new Error("Unsupported token instruction discriminator");
  }
  if (bytes.length !== TRANSFER_CHECKED_DATA_LENGTH) {
    throw new Error("Invalid TransferChecked instruction length");
  }

  let amountBaseUnits = 0n;
  for (let index = 0; index < 8; index += 1) {
    const byte = bytes[index + 1];
    if (byte === undefined) {
      throw new Error("Invalid TransferChecked amount encoding");
    }
    amountBaseUnits |= BigInt(byte) << BigInt(index * 8);
  }

  const decimals = bytes[9];
  if (decimals === undefined) {
    throw new Error("Missing TransferChecked decimals");
  }

  return { amountBaseUnits, decimals };
}
