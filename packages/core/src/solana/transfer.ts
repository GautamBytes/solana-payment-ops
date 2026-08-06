import type { DecodedTransfer } from "../domain/types.js";
import { decodeTokenInstruction } from "./token-instruction.js";

export function decodeTransfer(data: string): DecodedTransfer {
  const decoded = decodeTokenInstruction(data);
  if (decoded.kind === "transfer") {
    return { amountBaseUnits: decoded.amountBaseUnits };
  }
  if (decoded.kind === "malformed" && decoded.discriminator === 3) {
    throw new Error("Invalid Transfer instruction length");
  }
  throw new Error("Expected SPL Token Transfer instruction");
}
