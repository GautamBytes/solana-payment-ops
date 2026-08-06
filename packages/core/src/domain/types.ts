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

export interface DecodedTransfer {
  readonly amountBaseUnits: bigint;
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

export type VerificationCode =
  | "transaction_success"
  | "cluster"
  | "commitment"
  | "token_program"
  | "mint"
  | "destination"
  | "destination_owner"
  | "destination_token_program"
  | "destination_balance_mint"
  | "amount"
  | "decimals"
  | "reference"
  | "unambiguous_reference_accounts"
  | "non_self_transfer"
  | "destination_balance_delta";

export interface VerificationCheck {
  readonly code: VerificationCode;
  readonly passed: boolean;
  readonly expected: string;
  readonly actual: string;
}

export interface VerificationReport {
  readonly schemaVersion: "0.1";
  readonly fixtureName: string;
  readonly eventId: string;
  readonly signature: string;
  readonly slot: number;
  readonly verified: boolean;
  readonly checks: readonly VerificationCheck[];
  readonly transfer: ParsedTransfer;
}
