import {
  LEGACY_TOKEN_PROGRAM_ADDRESS,
  TOKEN_2022_PROGRAM_ADDRESS,
} from "../domain/constants.js";
import type { ParsedTransfer } from "../domain/types.js";
import type {
  CompiledInstruction,
  PaymentFixture,
  RpcTransactionEnvelope,
} from "../fixtures/schema.js";
import { resolveAccountKeys } from "./compiled-message.js";
import { decodeTokenInstruction } from "./token-instruction.js";

interface InstructionLocation {
  readonly instruction: CompiledInstruction;
  readonly outerInstructionIndex: number;
  readonly innerInstructionIndex: number | null;
}

interface AssetEvidence {
  readonly mint: string;
  readonly decimals: number;
}

export class UnsupportedTransferEvidenceError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "UnsupportedTransferEvidenceError";
  }
}

function resolveAssetEvidence(
  transaction: RpcTransactionEnvelope,
  sourceAccountIndex: number,
  destinationAccountIndex: number,
): AssetEvidence {
  const balances = [
    ...transaction.meta.preTokenBalances,
    ...transaction.meta.postTokenBalances,
  ].filter(
    ({ accountIndex }) =>
      accountIndex === sourceAccountIndex ||
      accountIndex === destinationAccountIndex,
  );
  const coveredIndexes = new Set(
    balances.map(({ accountIndex }) => accountIndex),
  );
  if (
    !coveredIndexes.has(sourceAccountIndex) ||
    !coveredIndexes.has(destinationAccountIndex)
  ) {
    throw new UnsupportedTransferEvidenceError(
      "Legacy Transfer token-balance evidence is incomplete",
    );
  }

  const first = balances[0];
  if (first === undefined) {
    throw new UnsupportedTransferEvidenceError(
      "Legacy Transfer token-balance evidence is incomplete",
    );
  }
  const matches = balances.every(
    (balance) =>
      balance.mint === first.mint &&
      balance.uiTokenAmount.decimals === first.uiTokenAmount.decimals &&
      balance.programId === String(LEGACY_TOKEN_PROGRAM_ADDRESS),
  );
  if (!matches) {
    throw new UnsupportedTransferEvidenceError(
      "Legacy Transfer token-balance evidence is contradictory",
    );
  }
  return { mint: first.mint, decimals: first.uiTokenAmount.decimals };
}

function collectInstructionLocations(
  transaction: RpcTransactionEnvelope,
): readonly InstructionLocation[] {
  const outer = transaction.transaction.message.instructions.map(
    (instruction, outerInstructionIndex): InstructionLocation => ({
      instruction,
      outerInstructionIndex,
      innerInstructionIndex: null,
    }),
  );
  const inner = (transaction.meta.innerInstructions ?? []).flatMap(
    ({ index, instructions }) =>
      instructions.map(
        (instruction, innerInstructionIndex): InstructionLocation => ({
          instruction,
          outerInstructionIndex: index,
          innerInstructionIndex,
        }),
      ),
  );
  return [...outer, ...inner];
}

export function parseTransactionTransfers(
  transaction: RpcTransactionEnvelope,
  options: { readonly watchedAddress?: string } = {},
): readonly ParsedTransfer[] {
  const message = transaction.transaction.message;
  const accountKeys = resolveAccountKeys(
    message,
    transaction.meta.loadedAddresses,
  );

  return collectInstructionLocations(transaction).flatMap((location) => {
    const { instruction } = location;
    const program = accountKeys[instruction.programIdIndex];
    const affectsWatchedAddress =
      options.watchedAddress === undefined ||
      instruction.accounts.some(
        (index) => accountKeys[index]?.address === options.watchedAddress,
      );
    if (program?.address === String(TOKEN_2022_PROGRAM_ADDRESS)) {
      if (!affectsWatchedAddress) return [];
      throw new UnsupportedTransferEvidenceError(
        "Token-2022 instructions are not supported",
      );
    }
    if (program?.address !== String(LEGACY_TOKEN_PROGRAM_ADDRESS)) {
      return [];
    }

    const decoded = decodeTokenInstruction(instruction.data);
    if (decoded.kind === "unsupported") {
      if (!affectsWatchedAddress) return [];
      throw new UnsupportedTransferEvidenceError(
        "Unsupported SPL Token instruction affects the watched account",
      );
    }
    if (decoded.kind === "malformed") {
      if (!affectsWatchedAddress) return [];
      throw new UnsupportedTransferEvidenceError(
        "Malformed SPL Token instruction affects the watched account",
      );
    }

    let instructionKind: "transfer" | "transferChecked";
    let amountBaseUnits: bigint;
    let decimals: number;
    let mintAddress: string;
    let sourcePosition: number;
    let destinationPosition: number;
    let authorityPosition: number;
    let extrasStart: number;

    if (decoded.kind === "transferChecked") {
      instructionKind = "transferChecked";
      amountBaseUnits = decoded.amountBaseUnits;
      decimals = decoded.decimals;
      sourcePosition = 0;
      destinationPosition = 2;
      authorityPosition = 3;
      extrasStart = 4;
      const mintIndex = instruction.accounts[1];
      const mint = mintIndex === undefined ? undefined : accountKeys[mintIndex];
      if (mint === undefined) {
        throw new UnsupportedTransferEvidenceError(
          "TransferChecked account evidence is incomplete",
        );
      }
      mintAddress = mint.address;
    } else {
      instructionKind = "transfer";
      amountBaseUnits = decoded.amountBaseUnits;
      sourcePosition = 0;
      destinationPosition = 1;
      authorityPosition = 2;
      extrasStart = 3;
      const sourceIndex = instruction.accounts[sourcePosition];
      const destinationIndex = instruction.accounts[destinationPosition];
      if (sourceIndex === undefined || destinationIndex === undefined) {
        throw new UnsupportedTransferEvidenceError(
          "Legacy Transfer account evidence is incomplete",
        );
      }
      const evidence = resolveAssetEvidence(
        transaction,
        sourceIndex,
        destinationIndex,
      );
      mintAddress = evidence.mint;
      decimals = evidence.decimals;
    }

    const instructionAccounts = instruction.accounts.map((index) => ({
      index,
      meta: accountKeys[index],
    }));
    const source = instructionAccounts[sourcePosition];
    const destination = instructionAccounts[destinationPosition];
    const authority = instructionAccounts[authorityPosition];
    if (
      source?.meta === undefined ||
      destination?.meta === undefined ||
      authority?.meta === undefined
    ) {
      throw new UnsupportedTransferEvidenceError(
        "Token transfer account evidence is incomplete",
      );
    }

    if (instructionKind === "transferChecked") {
      const relevantBalances = [
        ...transaction.meta.preTokenBalances,
        ...transaction.meta.postTokenBalances,
      ].filter(
        ({ accountIndex }) =>
          accountIndex === source.index || accountIndex === destination.index,
      );
      if (relevantBalances.length > 0) {
        const evidence = resolveAssetEvidence(
          transaction,
          source.index,
          destination.index,
        );
        if (evidence.mint !== mintAddress || evidence.decimals !== decimals) {
          throw new UnsupportedTransferEvidenceError(
            "TransferChecked token-balance evidence is contradictory",
          );
        }
      }
    }

    const extras = instructionAccounts.slice(extrasStart);
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
        eventId: `${transaction.cluster}:${transaction.signature}:${location.outerInstructionIndex}:${innerPart}`,
        signature: transaction.signature,
        slot: transaction.slot,
        outerInstructionIndex: location.outerInstructionIndex,
        innerInstructionIndex: location.innerInstructionIndex,
        programId: program.address,
        sourceTokenAccount: source.meta.address,
        sourceAccountIndex: source.index,
        mint: mintAddress,
        destinationTokenAccount: destination.meta.address,
        destinationAccountIndex: destination.index,
        authority: authority.meta.address,
        amountBaseUnits: amountBaseUnits.toString(),
        decimals,
        references,
        unsupportedExtraAccounts,
      },
    ];
  });
}

export function parseTransferCheckedEvents(
  fixture: PaymentFixture,
): readonly ParsedTransfer[] {
  return parseTransactionTransfers(fixture.rpcTransaction);
}
