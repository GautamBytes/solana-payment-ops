interface SharedSecurityHeaderInput {
  readonly nonce: string;
  readonly apiOrigin?: string;
  readonly development: boolean;
  readonly allowSameOriginForms?: boolean;
  readonly noStore?: boolean;
}

export function checkoutSecurityHeaders(
  input: SharedSecurityHeaderInput & { readonly apiOrigin: string },
): Readonly<Record<string, string>> {
  return securityHeaders(input, true);
}

export function publicPageSecurityHeaders(
  input: SharedSecurityHeaderInput,
): Readonly<Record<string, string>> {
  return securityHeaders(input, false);
}

function securityHeaders(
  input: SharedSecurityHeaderInput,
  noIndex: boolean,
): Readonly<Record<string, string>> {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(input.nonce)) {
    throw new TypeError("CSP nonce is invalid");
  }
  const apiOrigin =
    input.apiOrigin === undefined ? "" : ` ${exactOrigin(input.apiOrigin)}`;
  const developmentEval = input.development ? " 'unsafe-eval'" : "";
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${input.nonce}' 'strict-dynamic'${developmentEval}`,
    `style-src 'self' 'nonce-${input.nonce}'`,
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self'${apiOrigin}`,
    "object-src 'none'",
    "base-uri 'none'",
    input.allowSameOriginForms === true
      ? "form-action 'self'"
      : "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
  return {
    ...(input.noStore === true || noIndex
      ? { "Cache-Control": "private, no-store" }
      : {}),
    "Content-Security-Policy": csp,
    "Permissions-Policy":
      "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    ...(noIndex
      ? { "X-Robots-Tag": "noindex, nofollow, noarchive" }
      : {}),
  };
}

function exactOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.origin !== value ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ))
  ) {
    throw new TypeError("API origin is invalid");
  }
  return url.origin;
}
