import { cookies } from "next/headers";
import { downloadOperationFile } from "../../../../../../lib/operations-api";
import { payopsCookieHeader } from "../../../../../../lib/auth-cookie";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  if (!UUID.test(id)) return new Response("Not found", { status: 404 });
  const cookie = payopsCookieHeader((await cookies()).getAll());
  const response = await downloadOperationFile(
    cookie,
    `/v1/evidence-packs/${encodeURIComponent(id)}/verification`,
    "application/json",
  );
  if (!response.ok || response.body === null)
    return new Response("Verification unavailable", {
      status: response.status,
    });
  return new Response(response.body, {
    headers: {
      "content-type": "application/json",
      "content-disposition": `attachment; filename="payops-evidence-${id}-verification.json"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
