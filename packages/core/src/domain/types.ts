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
