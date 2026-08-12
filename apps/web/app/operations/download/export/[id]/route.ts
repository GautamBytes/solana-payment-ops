import { cookies } from "next/headers";
import { downloadOperationFile } from "../../../../../lib/operations-api";
import { payopsCookieHeader } from "../../../../../lib/auth-cookie";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      id,
    )
  )
    return new Response("Not found", { status: 404 });
  const cookie = payopsCookieHeader((await cookies()).getAll());
  const response = await downloadOperationFile(
    cookie,
    `/v1/exports/${encodeURIComponent(id)}`,
    "text/csv",
  );
  if (!response.ok || response.body === null)
    return new Response("Export unavailable", { status: response.status });
  const contentDigest = response.headers.get("x-payops-content-digest");
  if (contentDigest === null || !/^[0-9a-f]{64}$/u.test(contentDigest)) {
    await response.body.cancel();
    return new Response("Export unavailable", { status: 502 });
  }
  return new Response(response.body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="payops-export.csv"',
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-payops-content-digest": contentDigest,
    },
  });
}
