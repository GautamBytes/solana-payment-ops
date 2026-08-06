import type { DecodedTransferChecked } from "../domain/types.js";
import { decodeTokenInstruction } from "./token-instruction.js";

export function decodeTransferChecked(data: string): DecodedTransferChecked {
  const decoded = decodeTokenInstruction(data);
  if (decoded.kind === "transferChecked") {
    return {
      amountBaseUnits: decoded.amountBaseUnits,
      decimals: decoded.decimals,
    };
  }
  if (decoded.kind === "malformed" && decoded.discriminator === 12) {
    throw new Error("Invalid TransferChecked instruction length");
  }
  throw new Error("Unsupported token instruction discriminator");
}
