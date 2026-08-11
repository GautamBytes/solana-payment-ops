export interface TokenAccountState {
  readonly address: string;
  readonly owner: string;
  readonly mint: string;
  readonly programOwner: string;
}

export interface FinalizedHead {
  readonly slot: bigint;
  readonly signature: string | null;
}

export interface SolanaAccountRpcPort {
  getTokenAccount(address: string): Promise<TokenAccountState | null>;
  getFinalizedHead(): Promise<FinalizedHead>;
}
