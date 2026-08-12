import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { downloadOperationFile } from "../../../../../lib/operations-api";
import { payopsCookieHeader } from "../../../../../lib/auth-cookie";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      id,
    )
  )
    return new Response("Not found", { status: 404 });
  const format = request.nextUrl.searchParams.get("format");
  if (format !== "json" && format !== "pdf")
    return new Response("Not found", { status: 404 });
  const response = await downloadOperationFile(
    await cookieHeader(),
    `/v1/evidence-packs/${encodeURIComponent(id)}?format=${format}`,
    format === "pdf" ? "application/pdf" : "application/json",
  );
  if (!response.ok || response.body === null)
    return new Response("Evidence unavailable", { status: response.status });
  return new Response(response.body, {
    status: 200,
    headers: safeDownloadHeaders(
      response,
      format === "pdf" ? "evidence.pdf" : "evidence.json",
    ),
  });
}

async function cookieHeader(): Promise<string> {
  return payopsCookieHeader((await cookies()).getAll());
}
function safeDownloadHeaders(response: Response, filename: string): Headers {
  const headers = new Headers({
    "content-type":
      response.headers.get("content-type") ?? "application/octet-stream",
    "content-disposition": `attachment; filename="${filename}"`,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  const digest = response.headers.get("x-content-sha256");
  if (digest !== null && /^[0-9a-f]{64}$/u.test(digest))
    headers.set("x-content-sha256", digest);
  const manifestDigest = response.headers.get("x-payops-manifest-digest");
  if (manifestDigest !== null && /^[0-9a-f]{64}$/u.test(manifestDigest))
    headers.set("x-payops-manifest-digest", manifestDigest);
  const signature = response.headers.get("x-payops-signature");
  if (signature !== null && /^[A-Za-z0-9_-]{86}$/u.test(signature))
    headers.set("x-payops-signature", signature);
  const signingKeyId = response.headers.get("x-payops-signing-key-id");
  if (
    signingKeyId !== null &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(signingKeyId)
  )
    headers.set("x-payops-signing-key-id", signingKeyId);
  return headers;
}
