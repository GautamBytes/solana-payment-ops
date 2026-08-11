import type { AuthEmail, EmailDeliveryPort } from "./email-port.js";

export class EmailDeliveryError extends Error {
  public readonly code: string;

  public constructor(code: string, cause?: unknown) {
    super(
      "Authentication email delivery failed",
      cause === undefined ? undefined : { cause },
    );
    this.name = "EmailDeliveryError";
    this.code = code;
  }
}

export interface HttpEmailDeliveryPortOptions {
  readonly endpoint: string;
  readonly bearerToken: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

export class HttpEmailDeliveryPort implements EmailDeliveryPort {
  readonly #endpoint: string;
  readonly #bearerToken: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  public constructor(options: HttpEmailDeliveryPortOptions) {
    this.#endpoint = validateEndpoint(options.endpoint);
    if (options.bearerToken.length < 32 || /\s/.test(options.bearerToken)) {
      throw new EmailDeliveryError("invalid_email_delivery_configuration");
    }
    this.#bearerToken = options.bearerToken;
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    if (
      !Number.isSafeInteger(this.#timeoutMs) ||
      this.#timeoutMs < 1_000 ||
      this.#timeoutMs > 30_000
    ) {
      throw new EmailDeliveryError("invalid_email_delivery_configuration");
    }
  }

  public async send(message: AuthEmail): Promise<void> {
    try {
      const response = await this.#fetch(this.#endpoint, {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(this.#timeoutMs),
        headers: {
          authorization: `Bearer ${this.#bearerToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          ...message,
          ...(message.expiresAt === undefined
            ? {}
            : { expiresAt: message.expiresAt.toISOString() }),
        }),
      });
      if (response.status < 200 || response.status >= 300) {
        throw new EmailDeliveryError("email_delivery_rejected");
      }
    } catch (error) {
      if (safeOwnCode(error) === "email_delivery_rejected") {
        throw new EmailDeliveryError("email_delivery_rejected");
      }
      throw new EmailDeliveryError("email_delivery_unavailable", error);
    }
  }
}

function safeOwnCode(error: unknown): string | undefined {
  if (
    error === null ||
    (typeof error !== "object" && typeof error !== "function")
  ) {
    return undefined;
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, "code");
    return descriptor !== undefined &&
      "value" in descriptor &&
      typeof descriptor.value === "string"
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function validateEndpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new EmailDeliveryError("invalid_email_delivery_configuration");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new EmailDeliveryError("invalid_email_delivery_configuration");
  }
  return url.toString();
}
