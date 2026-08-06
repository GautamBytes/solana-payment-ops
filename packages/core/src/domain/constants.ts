import { address } from "@solana/kit";

export const LEGACY_TOKEN_PROGRAM_ADDRESS = address(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
);

export const MAINNET_USDC = {
  symbol: "USDC",
  mint: address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
  tokenProgram: LEGACY_TOKEN_PROGRAM_ADDRESS,
  decimals: 6,
} as const;

export const MAINNET_USDT = {
  symbol: "USDT",
  mint: address("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"),
  tokenProgram: LEGACY_TOKEN_PROGRAM_ADDRESS,
  decimals: 6,
} as const;

export const SUPPORTED_MAINNET_ASSETS = {
  USDC: MAINNET_USDC,
  USDT: MAINNET_USDT,
} as const;
