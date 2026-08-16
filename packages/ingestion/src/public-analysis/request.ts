import { SUPPORTED_MAINNET_ASSETS } from "@payops/core";
import {
  address,
  getAddressEncoder,
  getProgramDerivedAddress,
} from "@solana/kit";

import type { PublicWalletAnalysisInput } from "./wallet-analysis.js";

const associatedTokenProgramAddress = address(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);
const amountPattern = /^(0|[1-9][0-9]{0,17})(\.[0-9]{1,6})?$/;
const dayMs = 86_400_000;

export type PublicWalletRequestField =
  | "walletAddress"
  | "rangeDays"
  | "assetSymbol"
  | "amountTokens"
  | "recipient"
  | "reference";

export interface PublicWalletAnalysisRequest {
  readonly walletAddress: string;
  readonly rangeDays: 7 | 30;
  readonly expectation?: {
    readonly assetSymbol?: "USDC" | "USDT";
    readonly amountTokens?: string;
    readonly recipient?: string;
    readonly reference?: string;
  };
}

export interface PreparedPublicWalletAnalysisRequest {
  readonly request: PublicWalletAnalysisRequest;
  readonly input: PublicWalletAnalysisInput;
}

export class PublicWalletRequestError extends Error {
  public constructor(readonly field: PublicWalletRequestField) {
    super("Public wallet analysis request is invalid");
    this.name = "PublicWalletRequestError";
  }
}

export async function preparePublicWalletAnalysisRequest(
  value: unknown,
  now: Date,
): Promise<PreparedPublicWalletAnalysisRequest> {
  const request = parseRequest(value);
  const watchedTokenAccounts = await Promise.all(
    (["USDC", "USDT"] as const).map(async (assetSymbol) => ({
      assetSymbol,
      address: await associatedTokenAddress(request.walletAddress, assetSymbol),
    })),
  );
  const expectation = await prepareExpectation(request.expectation);
  return {
    request,
    input: {
      walletAddress: request.walletAddress,
      watchedTokenAccounts,
      fromTime: new Date(now.getTime() - request.rangeDays * dayMs),
      throughTime: now,
      ...(expectation === undefined ? {} : { expectation }),
    },
  };
}

function parseRequest(value: unknown): PublicWalletAnalysisRequest {
  const body = record(value, "walletAddress");
  exactKeys(body, ["walletAddress", "rangeDays", "expectation"]);
  const walletAddress = canonicalAddress(body.walletAddress, "walletAddress");
  if (body.rangeDays !== 7 && body.rangeDays !== 30) {
    throw new PublicWalletRequestError("rangeDays");
  }
  if (body.expectation === undefined) {
    return { walletAddress, rangeDays: body.rangeDays };
  }

  const raw = record(body.expectation, "assetSymbol");
  exactKeys(raw, ["assetSymbol", "amountTokens", "recipient", "reference"]);
  const expectation: {
    assetSymbol?: "USDC" | "USDT";
    amountTokens?: string;
    recipient?: string;
    reference?: string;
  } = {};
  if (raw.assetSymbol !== undefined) {
    if (raw.assetSymbol !== "USDC" && raw.assetSymbol !== "USDT") {
      throw new PublicWalletRequestError("assetSymbol");
    }
    expectation.assetSymbol = raw.assetSymbol;
  }
  if (raw.amountTokens !== undefined) {
    if (
      typeof raw.amountTokens !== "string" ||
      !amountPattern.test(raw.amountTokens)
    ) {
      throw new PublicWalletRequestError("amountTokens");
    }
    expectation.amountTokens = raw.amountTokens;
  }
  if (raw.recipient !== undefined) {
    if (expectation.assetSymbol === undefined) {
      throw new PublicWalletRequestError("recipient");
    }
    expectation.recipient = canonicalAddress(raw.recipient, "recipient");
  }
  if (raw.reference !== undefined) {
    expectation.reference = canonicalAddress(raw.reference, "reference");
  }
  return { walletAddress, rangeDays: body.rangeDays, expectation };
}

async function prepareExpectation(
  expectation: PublicWalletAnalysisRequest["expectation"],
): Promise<PublicWalletAnalysisInput["expectation"]> {
  if (expectation === undefined) return undefined;
  return {
    ...(expectation.assetSymbol === undefined
      ? {}
      : { assetSymbol: expectation.assetSymbol }),
    ...(expectation.amountTokens === undefined
      ? {}
      : { amountBaseUnits: toBaseUnits(expectation.amountTokens) }),
    ...(expectation.recipient === undefined ||
    expectation.assetSymbol === undefined
      ? {}
      : {
          destinationTokenAccount: await associatedTokenAddress(
            expectation.recipient,
            expectation.assetSymbol,
          ),
        }),
    ...(expectation.reference === undefined
      ? {}
      : { reference: expectation.reference }),
  };
}

async function associatedTokenAddress(
  walletAddress: string,
  assetSymbol: "USDC" | "USDT",
): Promise<string> {
  const asset = SUPPORTED_MAINNET_ASSETS[assetSymbol];
  const encoder = getAddressEncoder();
  try {
    const [derived] = await getProgramDerivedAddress({
      programAddress: associatedTokenProgramAddress,
      seeds: [
        encoder.encode(address(walletAddress)),
        encoder.encode(asset.tokenProgram),
        encoder.encode(asset.mint),
      ],
    });
    return derived;
  } catch {
    throw new PublicWalletRequestError("walletAddress");
  }
}

function canonicalAddress(
  value: unknown,
  field: PublicWalletRequestField,
): string {
  if (typeof value !== "string") throw new PublicWalletRequestError(field);
  try {
    const canonical = address(value);
    if (canonical !== value) throw new Error("noncanonical address");
    return canonical;
  } catch {
    throw new PublicWalletRequestError(field);
  }
}

function toBaseUnits(amountTokens: string): string {
  const [integer = "0", fraction = ""] = amountTokens.split(".");
  return BigInt(`${integer}${fraction.padEnd(6, "0")}`).toString();
}

function record(
  value: unknown,
  field: PublicWalletRequestField,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PublicWalletRequestError(field);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new PublicWalletRequestError("walletAddress");
  }
}
