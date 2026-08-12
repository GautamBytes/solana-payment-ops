import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CheckoutTokenKeyring,
  PublicTokenError,
} from "../src/security/public-token.js";

const keyOne = Buffer.alloc(32, 1).toString("base64url");
const keyTwo = Buffer.alloc(32, 2).toString("base64url");

describe("checkout bearer tokens", () => {
  it("derives a 32-byte unpadded token bound to checkout, nonce, and key", () => {
    const checkoutId = "00000000-0000-4000-8000-000000000123";
    const nonce = Buffer.alloc(32, 7);
    const keyring = new CheckoutTokenKeyring([
      { id: "key-v2", secret: keyTwo },
      { id: "key-v1", secret: keyOne },
    ]);
    const first = keyring.derive(checkoutId, nonce, "key-v2");
    const repeated = keyring.derive(checkoutId, nonce, "key-v2");
    expect(first).toEqual(repeated);
    expect(Buffer.from(first.token, "base64url")).toHaveLength(32);
    expect(first.token).not.toContain("=");
    expect(first.digest).toBe(
      createHash("sha256")
        .update(Buffer.from(first.token, "base64url"))
        .digest("hex"),
    );
    expect(keyring.derive(randomUUID(), nonce, "key-v2").token).not.toBe(
      first.token,
    );
    expect(
      keyring.derive(checkoutId, Buffer.alloc(32, 8), "key-v2").token,
    ).not.toBe(first.token);
    expect(keyring.derive(checkoutId, nonce, "key-v1").token).not.toBe(
      first.token,
    );
  });

  it("creates random public material and hashes decoded tokens for lookup", () => {
    const keyring = new CheckoutTokenKeyring([
      { id: "key-v1", secret: keyOne },
    ]);
    const first = keyring.create(randomUUID());
    const second = keyring.create(randomUUID());
    expect(first.keyId).toBe("key-v1");
    expect(first.publicNonce).toHaveLength(32);
    expect(second.publicNonce).toHaveLength(32);
    expect(first.publicNonce).not.toEqual(second.publicNonce);
    expect(keyring.digestToken(first.token)).toBe(first.digest);
  });

  it.each(["", "a", "!".repeat(43), "a".repeat(44), "=".repeat(43)])(
    "rejects malformed lookup token without distinguishing it",
    (token) => {
      const keyring = new CheckoutTokenKeyring([
        { id: "key-v1", secret: keyOne },
      ]);
      expect(() => keyring.digestToken(token)).toThrowError(
        expect.objectContaining<Partial<PublicTokenError>>({
          code: "invalid_checkout_token",
        }),
      );
    },
  );

  it("fails safely when a referenced retired key is unavailable", () => {
    const keyring = new CheckoutTokenKeyring([
      { id: "key-v2", secret: keyTwo },
    ]);
    expect(() =>
      keyring.derive(randomUUID(), Buffer.alloc(32), "key-v1"),
    ).toThrowError(
      expect.objectContaining({ code: "checkout_token_key_unavailable" }),
    );
  });
});
