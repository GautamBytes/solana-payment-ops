import { createSignableMessage, generateKeyPairSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  createWalletProofMessage,
  verifyWalletProof,
  type WalletProofFields,
} from "../src/index.js";

describe("wallet ownership proof", () => {
  it("verifies a valid signature after base64url transport decoding", async () => {
    const fields: WalletProofFields = {
      domain: "payops.test",
      organizationId: "00000000-0000-4000-8000-000000000001",
      address: "44QXWLMvVST4BgRNQEaNKU7JYHHayd4R68MwP9dKp3Np",
      nonce: "9JD2UX_ZEkxNI-n_AApj1JftWZBklGGE3n9VpNiBk7A",
      issuedAt: new Date("2026-08-12T00:00:02.000Z"),
      expiresAt: new Date("2026-08-12T00:10:02.000Z"),
    };

    await expect(
      verifyWalletProof({
        fields,
        signature:
          "O-_9k6GptBwrWpMFW1ktdTYADWFWVCKnsy29rjWD7wP6LJuswXiHTqsEwCg4IYaSfAZ9O_0Cgi7Deea_oRNiAQ",
        now: new Date("2026-08-12T00:05:00.000Z"),
      }),
    ).resolves.toBeUndefined();
  });

  it("verifies only the exact UTF-8 message and bound fields", async () => {
    const signer = await generateKeyPairSigner();
    const fields: WalletProofFields = {
      domain: "payops.example",
      organizationId: "00000000-0000-4000-8000-000000000001",
      address: signer.address,
      nonce: "A".repeat(43),
      issuedAt: new Date("2026-08-12T00:00:00.000Z"),
      expiresAt: new Date("2026-08-12T00:10:00.000Z"),
    };
    const message = createWalletProofMessage(fields);
    expect(message).toBe(
      [
        "PayOps Wallet Ownership Proof",
        "Domain: payops.example",
        "Organization: 00000000-0000-4000-8000-000000000001",
        `Address: ${signer.address}`,
        "Cluster: mainnet-beta",
        `Nonce: ${"A".repeat(43)}`,
        "Issued At: 2026-08-12T00:00:00.000Z",
        "Expires At: 2026-08-12T00:10:00.000Z",
      ].join("\n"),
    );
    expect(message.endsWith("\n")).toBe(false);
    const [signatures] = await signer.signMessages([
      createSignableMessage(message),
    ]);
    const signature = Buffer.from(signatures![signer.address]!).toString(
      "base64url",
    );
    await expect(
      verifyWalletProof({
        fields,
        signature,
        now: new Date("2026-08-12T00:05:00.000Z"),
      }),
    ).resolves.toBeUndefined();

    for (const changed of [
      { ...fields, domain: "evil.example" },
      { ...fields, organizationId: "00000000-0000-4000-8000-000000000002" },
      { ...fields, nonce: `B${"A".repeat(42)}` },
      {
        ...fields,
        issuedAt: new Date("2026-08-12T00:00:01.000Z"),
        expiresAt: new Date("2026-08-12T00:10:01.000Z"),
      },
    ]) {
      await expect(
        verifyWalletProof({
          fields: changed,
          signature,
          now: new Date("2026-08-12T00:05:00.000Z"),
        }),
      ).rejects.toMatchObject({ code: "invalid_wallet_proof" });
    }
    await expect(
      verifyWalletProof({
        fields,
        signature,
        now: fields.expiresAt,
      }),
    ).rejects.toMatchObject({ code: "invalid_wallet_proof" });
    const corrupted = Buffer.from(signature, "base64url");
    corrupted[0] = corrupted[0]! ^ 1;
    await expect(
      verifyWalletProof({
        fields,
        signature: corrupted.toString("base64url"),
        now: new Date("2026-08-12T00:05:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "invalid_wallet_proof" });
  });
});
