export function payopsCookieHeader(
  cookies: readonly { readonly name: string; readonly value: string }[],
): string {
  return cookies
    .filter(
      ({ name }) =>
        name === "payops.session_token" ||
        name === "__Secure-payops.session_token",
    )
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");
}
