import {
  address,
  getAddressEncoder,
  getProgramDerivedAddress,
  getPublicKeyFromAddress,
  signatureBytes,
  verifySignature,
} from "@solana/kit";
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  type AssetDefinition,
} from "./asset-registry.js";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const noncePattern = /^[A-Za-z0-9_-]{43}$/;
const domainPattern = /^[A-Za-z0-9.-]{1,253}$/;

export interface WalletProofFields {
  readonly domain: string;
  readonly organizationId: string;
  readonly address: string;
  readonly nonce: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

export class WalletProofError extends Error {
  public readonly code: string;

  public constructor(code: string) {
    super("Wallet ownership proof is invalid");
    this.name = "WalletProofError";
    this.code = code;
  }
}

export function createWalletProofMessage(fields: WalletProofFields): string {
  const canonicalAddress = canonicalSolanaAddress(fields.address);
  validateFields(fields);
  return [
    "PayOps Wallet Ownership Proof",
    `Domain: ${fields.domain}`,
    `Organization: ${fields.organizationId}`,
    `Address: ${canonicalAddress}`,
    "Cluster: mainnet-beta",
    `Nonce: ${fields.nonce}`,
    `Issued At: ${fields.issuedAt.toISOString()}`,
    `Expires At: ${fields.expiresAt.toISOString()}`,
  ].join("\n");
}

export async function verifyWalletProof(input: {
  readonly fields: WalletProofFields;
  readonly signature: string;
  readonly now: Date;
}): Promise<void> {
  if (
    !Number.isFinite(input.now.getTime()) ||
    input.fields.issuedAt.getTime() > input.now.getTime() + 30_000 ||
    input.fields.expiresAt.getTime() <= input.now.getTime()
  ) {
    throw new WalletProofError("invalid_wallet_proof");
  }
  const message = createWalletProofMessage(input.fields);
  let signatureValue: Uint8Array;
  try {
    signatureValue = Buffer.from(input.signature, "base64url");
    if (
      signatureValue.byteLength !== 64 ||
      Buffer.from(signatureValue).toString("base64url") !== input.signature
    ) {
      throw new Error("invalid signature");
    }
    const publicKey = await getPublicKeyFromAddress(
      address(input.fields.address),
    );
    const valid = await verifySignature(
      publicKey,
      signatureBytes(signatureValue),
      new TextEncoder().encode(message),
    );
    if (!valid) throw new Error("invalid signature");
  } catch {
    throw new WalletProofError("invalid_wallet_proof");
  }
}

export async function associatedTokenAddress(
  walletAddress: string,
  asset: AssetDefinition,
): Promise<string> {
  const encoder = getAddressEncoder();
  try {
    const [derived] = await getProgramDerivedAddress({
      programAddress: address(ASSOCIATED_TOKEN_PROGRAM_ADDRESS),
      seeds: [
        encoder.encode(address(walletAddress)),
        encoder.encode(address(asset.tokenProgram)),
        encoder.encode(address(asset.mint)),
      ],
    });
    return derived;
  } catch {
    throw new WalletProofError("invalid_wallet_address");
  }
}

export function canonicalSolanaAddress(value: string): string {
  try {
    const parsed = address(value);
    if (parsed !== value) throw new Error("noncanonical address");
    return parsed;
  } catch {
    throw new WalletProofError("invalid_wallet_address");
  }
}

function validateFields(fields: WalletProofFields): void {
  if (
    !domainPattern.test(fields.domain) ||
    !uuidPattern.test(fields.organizationId) ||
    !noncePattern.test(fields.nonce) ||
    !Number.isFinite(fields.issuedAt.getTime()) ||
    !Number.isFinite(fields.expiresAt.getTime()) ||
    fields.expiresAt.getTime() - fields.issuedAt.getTime() !== 10 * 60 * 1_000
  ) {
    throw new WalletProofError("invalid_wallet_proof");
  }
}
