import ipaddr from "ipaddr.js";

const hostnamePattern =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const canonicalHttpsPrefixPattern = /^https:\/\//i;
const authorityPattern = /^https:\/\/([^/?#]+)/i;
const bracketedAuthorityPattern = /^\[([^\]]+)\](?::443)?$/;
const nonBracketedAuthorityPattern = /^[^:[\]]+(?::443)?$/;
const forbiddenRawUrlCharacterPattern = /[\u0000-\u0020\u007f]/;
const ipv6GlobalUnicastNetwork = ipaddr.IPv6.parse("2000::");

export interface EndpointPolicy {
  readonly allowUnsafeAddressesForTesting?: boolean;
}

export interface ValidatedEndpoint {
  readonly url: string;
}

export class UnsafeEndpointError extends Error {
  readonly code = "unsafe_endpoint";

  constructor(message: string) {
    super(message);
    this.name = "UnsafeEndpointError";
  }
}

export function validateEndpointUrl(
  input: string,
  policy?: EndpointPolicy,
): ValidatedEndpoint {
  if (
    forbiddenRawUrlCharacterPattern.test(input) ||
    !canonicalHttpsPrefixPattern.test(input) ||
    input.includes("\\")
  ) {
    throw unsafeEndpoint("Endpoint URL has invalid raw syntax");
  }

  const rawAuthority = authorityPattern.exec(input)?.[1];
  if (rawAuthority === undefined) {
    throw unsafeEndpoint("Endpoint URL requires a non-empty authority");
  }
  if (rawAuthority.includes("@")) {
    throw unsafeEndpoint("Endpoint URL must not contain userinfo");
  }

  let rawIpv6Literal: string | undefined;
  if (rawAuthority.startsWith("[")) {
    const bracketedAuthority = bracketedAuthorityPattern.exec(rawAuthority);
    rawIpv6Literal = bracketedAuthority?.[1];
    if (rawIpv6Literal === undefined) {
      throw unsafeEndpoint("Endpoint URL has an invalid bracketed authority");
    }
  } else if (!nonBracketedAuthorityPattern.test(rawAuthority)) {
    throw unsafeEndpoint("Endpoint URL has an invalid authority");
  }

  if (
    rawIpv6Literal !== undefined &&
    hasUnsupportedAddressSyntax(rawIpv6Literal)
  ) {
    throw unsafeEndpoint("Endpoint address is not publicly routable");
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw unsafeEndpoint("Endpoint URL is invalid");
  }

  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    input.includes("#") ||
    url.port !== ""
  ) {
    throw unsafeEndpoint("Endpoint URL must use HTTPS on port 443");
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const normalizedHostname = hostname.toLowerCase();
  if (
    normalizedHostname === "localhost" ||
    normalizedHostname.endsWith(".localhost")
  ) {
    throw unsafeEndpoint("Endpoint hostname is not publicly routable");
  }

  if (ipaddr.isValid(hostname)) {
    assertPublicAddressWithPolicy(hostname, policy);
  } else if (!hostnamePattern.test(hostname)) {
    throw unsafeEndpoint("Endpoint hostname is invalid");
  }

  return { url: url.toString() };
}

export function assertPublicAddress(
  address: string,
  policy?: EndpointPolicy,
): void {
  assertPublicAddressWithPolicy(address, policy);
}

function assertPublicAddressWithPolicy(
  address: string,
  policy?: EndpointPolicy,
): void {
  if (hasUnsupportedAddressSyntax(address)) {
    throw unsafeEndpoint("Address is not publicly routable");
  }

  let parsedAddress: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    parsedAddress = ipaddr.process(address);
  } catch {
    throw unsafeEndpoint("Address is invalid");
  }

  const isPublic =
    parsedAddress.range() === "unicast" &&
    (parsedAddress.kind() === "ipv4" ||
      parsedAddress.match(ipv6GlobalUnicastNetwork, 3));

  if (!isPublic && !policy?.allowUnsafeAddressesForTesting) {
    throw unsafeEndpoint("Address is not publicly routable");
  }
}

function hasUnsupportedAddressSyntax(address: string): boolean {
  return (
    (address.includes(":") && address.includes(".")) || address.includes("%")
  );
}

function unsafeEndpoint(message: string): UnsafeEndpointError {
  return new UnsafeEndpointError(message);
}
