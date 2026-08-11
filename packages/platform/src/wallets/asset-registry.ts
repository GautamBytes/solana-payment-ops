export const LEGACY_TOKEN_PROGRAM_ADDRESS =
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

export const ASSOCIATED_TOKEN_PROGRAM_ADDRESS =
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

export const ASSET_SYMBOLS = ["USDC", "USDT"] as const;
export type AssetSymbol = (typeof ASSET_SYMBOLS)[number];

export interface AssetDefinition {
  readonly symbol: AssetSymbol;
  readonly cluster: "mainnet-beta";
  readonly mint: string;
  readonly decimals: 6;
  readonly tokenProgram: typeof LEGACY_TOKEN_PROGRAM_ADDRESS;
}

const assets = {
  USDC: {
    symbol: "USDC",
    cluster: "mainnet-beta",
    mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    decimals: 6,
    tokenProgram: LEGACY_TOKEN_PROGRAM_ADDRESS,
  },
  USDT: {
    symbol: "USDT",
    cluster: "mainnet-beta",
    mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    decimals: 6,
    tokenProgram: LEGACY_TOKEN_PROGRAM_ADDRESS,
  },
} as const satisfies Record<AssetSymbol, AssetDefinition>;

export function assetBySymbol(symbol: string): AssetDefinition {
  if (symbol !== "USDC" && symbol !== "USDT") {
    throw new AssetRegistryError("unsupported_asset");
  }
  return assets[symbol];
}

export function assetByMint(mint: string): AssetDefinition {
  const asset = ASSET_SYMBOLS.map((symbol) => assets[symbol]).find(
    (candidate) => candidate.mint === mint,
  );
  if (asset === undefined) throw new AssetRegistryError("unsupported_asset");
  return asset;
}

export class AssetRegistryError extends Error {
  public readonly code: string;

  public constructor(code: string) {
    super("Asset is not supported");
    this.name = "AssetRegistryError";
    this.code = code;
  }
}
