import { createHash, createHmac, randomBytes } from "node:crypto";

const domain = Buffer.from("PayOps Checkout v1\n", "utf8");
const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const keyIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type PublicTokenErrorCode =
  | "invalid_checkout_token_configuration"
  | "invalid_checkout_token"
  | "checkout_token_key_unavailable";

export class PublicTokenError extends Error {
  public constructor(readonly code: PublicTokenErrorCode) {
    super("Checkout capability is unavailable");
    this.name = "PublicTokenError";
  }
}

export interface CheckoutTokenMaterial {
  readonly token: string;
  readonly digest: string;
  readonly publicNonce: Uint8Array;
  readonly keyId: string;
}

export class CheckoutTokenKeyring {
  readonly #orderedKeys: readonly {
    readonly id: string;
    readonly secret: Uint8Array;
  }[];

  public constructor(
    keys: readonly { readonly id: string; readonly secret: string }[],
  ) {
    if (keys.length < 1 || keys.length > 8) invalidConfiguration();
    const ids = new Set<string>();
    this.#orderedKeys = Object.freeze(
      keys.map(({ id, secret }) => {
        let bytes: Buffer;
        try {
          bytes = Buffer.from(secret, "base64url");
        } catch {
          invalidConfiguration();
        }
        if (
          !keyIdPattern.test(id) ||
          ids.has(id) ||
          bytes.byteLength !== 32 ||
          bytes.toString("base64url") !== secret
        ) {
          invalidConfiguration();
        }
        ids.add(id);
        return { id, secret: new Uint8Array(bytes) };
      }),
    );
  }

  public create(checkoutId: string): CheckoutTokenMaterial {
    const active = this.#orderedKeys[0]!;
    const publicNonce = randomBytes(32);
    return {
      ...this.derive(checkoutId, publicNonce, active.id),
      publicNonce: new Uint8Array(publicNonce),
      keyId: active.id,
    };
  }

  public derive(
    checkoutId: string,
    publicNonce: Uint8Array,
    keyId: string,
  ): Omit<CheckoutTokenMaterial, "publicNonce" | "keyId"> {
    if (
      !canonicalUuidPattern.test(checkoutId) ||
      publicNonce.byteLength !== 32
    ) {
      throw new PublicTokenError("invalid_checkout_token");
    }
    const key = this.#orderedKeys.find((candidate) => candidate.id === keyId);
    if (key === undefined) {
      throw new PublicTokenError("checkout_token_key_unavailable");
    }
    const checkoutBytes = Buffer.from(checkoutId.replaceAll("-", ""), "hex");
    const tokenBytes = createHmac("sha256", key.secret)
      .update(domain)
      .update(checkoutBytes)
      .update(publicNonce)
      .digest();
    return {
      token: tokenBytes.toString("base64url"),
      digest: createHash("sha256").update(tokenBytes).digest("hex"),
    };
  }

  public digestToken(token: string): string {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) invalidToken();
    let bytes: Buffer;
    try {
      bytes = Buffer.from(token, "base64url");
    } catch {
      invalidToken();
    }
    if (bytes.byteLength !== 32 || bytes.toString("base64url") !== token) {
      invalidToken();
    }
    return createHash("sha256").update(bytes).digest("hex");
  }
}

function invalidToken(): never {
  throw new PublicTokenError("invalid_checkout_token");
}

function invalidConfiguration(): never {
  throw new PublicTokenError("invalid_checkout_token_configuration");
}
