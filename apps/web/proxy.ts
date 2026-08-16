import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import {
  checkoutSecurityHeaders,
  publicPageSecurityHeaders,
} from "./lib/security-headers";

export function proxy(request: NextRequest): NextResponse {
  const apiOrigin = process.env.NEXT_PUBLIC_PAYOPS_API_ORIGIN;
  const operational =
    request.nextUrl.pathname.startsWith("/pay/") ||
    request.nextUrl.pathname.startsWith("/operations");
  if (operational && typeof apiOrigin !== "string") {
    return new NextResponse("Checkout unavailable", { status: 503 });
  }
  const nonce = Buffer.from(randomUUID()).toString("base64");
  const headers = operational
    ? checkoutSecurityHeaders({
        nonce,
        apiOrigin: apiOrigin!,
        development: process.env.NODE_ENV === "development",
        allowSameOriginForms:
          request.nextUrl.pathname.startsWith("/operations"),
      })
    : publicPageSecurityHeaders({
        nonce,
        ...(typeof apiOrigin === "string" ? { apiOrigin } : {}),
        development: process.env.NODE_ENV === "development",
        noStore: request.nextUrl.pathname === "/try",
      });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set(
    "Content-Security-Policy",
    headers["Content-Security-Policy"]!,
  );
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  for (const [key, value] of Object.entries(headers)) {
    response.headers.set(key, value);
  }
  return response;
}

export const config = {
  matcher: [
    "/",
    "/try",
    "/docs/:path*",
    "/about",
    "/roadmap",
    "/pay/:path*",
    "/operations/:path*",
  ],
};
