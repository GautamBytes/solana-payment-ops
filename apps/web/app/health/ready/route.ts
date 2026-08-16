import { parseWebRuntimeConfig } from "../../../lib/runtime-config";

const headers = {
  "cache-control": "no-store",
  "content-type": "application/json",
} as const;

export async function GET(): Promise<Response> {
  let apiOrigin: string;
  try {
    apiOrigin = parseWebRuntimeConfig(process.env).apiOrigin;
  } catch {
    return notReady("invalid_web_origin_configuration");
  }

  try {
    const response = await fetch(`${apiOrigin}/health/ready`, {
      cache: "no-store",
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) return notReady("api_unavailable");
    return new Response('{"status":"ok"}', { status: 200, headers });
  } catch {
    return notReady("api_unavailable");
  }
}

function notReady(code: string): Response {
  return new Response(JSON.stringify({ status: "not_ready", code }), {
    status: 503,
    headers,
  });
}
