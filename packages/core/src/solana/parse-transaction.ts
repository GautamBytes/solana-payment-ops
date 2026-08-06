import { LEGACY_TOKEN_PROGRAM_ADDRESS } from "../domain/constants.js";
import type { ParsedTransfer } from "../domain/types.js";
import type {
  CompiledInstruction,
  PaymentFixture,
} from "../fixtures/schema.js";
import { resolveAccountKeys } from "./compiled-message.js";
import { decodeTransferChecked } from "./transfer-checked.js";

interface InstructionLocation {
  readonly instruction: CompiledInstruction;
  readonly outerInstructionIndex: number;
  readonly innerInstructionIndex: number | null;
}

export function parseTransferCheckedEvents(
  fixture: PaymentFixture,
): readonly ParsedTransfer[] {
  const { rpcTransaction } = fixture;
  const message = rpcTransaction.transaction.message;
  const accountKeys = resolveAccountKeys(
    message,
    rpcTransaction.meta.loadedAddresses,
  );

  const outerInstructions = message.instructions.map(
    (instruction, outerInstructionIndex): InstructionLocation => ({
      instruction,
      outerInstructionIndex,
      innerInstructionIndex: null,
    }),
  );
  const innerInstructions = (
    rpcTransaction.meta.innerInstructions ?? []
  ).flatMap(({ index, instructions }) =>
    instructions.map(
      (instruction, innerInstructionIndex): InstructionLocation => ({
        instruction,
        outerInstructionIndex: index,
        innerInstructionIndex,
      }),
    ),
  );

  return [...outerInstructions, ...innerInstructions].flatMap((location) => {
    const { instruction } = location;
    const program = accountKeys[instruction.programIdIndex];
    if (program?.address !== String(LEGACY_TOKEN_PROGRAM_ADDRESS)) {
      return [];
    }

    let decoded;
    try {
      decoded = decodeTransferChecked(instruction.data);
    } catch {
      return [];
    }

    const instructionAccounts = instruction.accounts.map((index) => ({
      index,
      meta: accountKeys[index],
    }));
    const source = instructionAccounts[0];
    const mint = instructionAccounts[1];
    const destination = instructionAccounts[2];
    const authority = instructionAccounts[3];

    if (
      source?.meta === undefined ||
      mint?.meta === undefined ||
      destination?.meta === undefined ||
      authority?.meta === undefined
    ) {
      return [];
    }

    const extras = instructionAccounts.slice(4);
    const references = extras
      .filter(
        ({ meta }) => meta !== undefined && !meta.signer && !meta.writable,
      )
      .map(({ meta }) => meta?.address)
      .filter((value): value is string => value !== undefined);
    const unsupportedExtraAccounts = extras
      .filter(({ meta }) => meta === undefined || meta.signer || meta.writable)
      .map(({ meta }) => meta?.address ?? "unresolved");
    const innerPart =
      location.innerInstructionIndex === null
        ? "outer"
        : String(location.innerInstructionIndex);

    return [
      {
        eventId: `${rpcTransaction.cluster}:${rpcTransaction.signature}:${location.outerInstructionIndex}:${innerPart}`,
        signature: rpcTransaction.signature,
        slot: rpcTransaction.slot,
        outerInstructionIndex: location.outerInstructionIndex,
        innerInstructionIndex: location.innerInstructionIndex,
        programId: program.address,
        sourceTokenAccount: source.meta.address,
        sourceAccountIndex: source.index,
        mint: mint.meta.address,
        destinationTokenAccount: destination.meta.address,
        destinationAccountIndex: destination.index,
        authority: authority.meta.address,
        amountBaseUnits: decoded.amountBaseUnits.toString(),
        decimals: decoded.decimals,
        references,
        unsupportedExtraAccounts,
      },
    ];
  });
}
