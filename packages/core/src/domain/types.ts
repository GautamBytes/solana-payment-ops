export interface ResolvedAccountKey {
  readonly address: string;
  readonly signer: boolean;
  readonly writable: boolean;
  readonly source: "static" | "loaded-writable" | "loaded-readonly";
}

export interface DecodedTransferChecked {
  readonly amountBaseUnits: bigint;
  readonly decimals: number;
}

export interface ParsedTransfer {
  readonly eventId: string;
  readonly signature: string;
  readonly slot: number;
  readonly outerInstructionIndex: number;
  readonly innerInstructionIndex: number | null;
  readonly programId: string;
  readonly sourceTokenAccount: string;
  readonly sourceAccountIndex: number;
  readonly mint: string;
  readonly destinationTokenAccount: string;
  readonly destinationAccountIndex: number;
  readonly authority: string;
  readonly amountBaseUnits: string;
  readonly decimals: number;
  readonly references: readonly string[];
  readonly unsupportedExtraAccounts: readonly string[];
}
