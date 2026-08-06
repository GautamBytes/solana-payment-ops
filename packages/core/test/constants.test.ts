import { describe, expect, it } from "vitest";
import {
  LEGACY_TOKEN_PROGRAM_ADDRESS,
  MAINNET_USDC,
  MAINNET_USDT,
  SUPPORTED_MAINNET_ASSETS,
} from "../src/index.js";

describe("canonical asset allowlist", () => {
  it("pins canonical mainnet USDC and USDT to the legacy token program", () => {
    expect(String(LEGACY_TOKEN_PROGRAM_ADDRESS)).toBe(
      "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    );
    expect(String(MAINNET_USDC.mint)).toBe(
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    );
    expect(String(MAINNET_USDT.mint)).toBe(
      "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    );
    expect(MAINNET_USDC.decimals).toBe(6);
    expect(MAINNET_USDT.decimals).toBe(6);
    expect(SUPPORTED_MAINNET_ASSETS).toEqual({
      USDC: MAINNET_USDC,
      USDT: MAINNET_USDT,
    });
  });
});
