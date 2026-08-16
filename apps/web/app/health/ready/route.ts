import { parseWebRuntimeConfig } from "../../../lib/runtime-config";

const headers = {
  "cache-control": "no-store",
  "content-type": "application/json",
} as const;

export async function GET(): Promise<Response> {
  let config: ReturnType<typeof parseWebRuntimeConfig>;
  try {
    config = parseWebRuntimeConfig(process.env);
  } catch {
    return notReady("invalid_web_origin_configuration");
  }

  if (config.mode === "embedded") {
    return new Response('{"status":"ok"}', { status: 200, headers });
  }

  try {
    const response = await fetch(`${config.readinessOrigin}/health/ready`, {
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
