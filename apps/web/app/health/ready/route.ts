import { parseWebRuntimeConfig } from "../../../lib/runtime-config";

const headers = {
  "cache-control": "no-store",
  "content-type": "application/json",
} as const;

export function GET(): Response {
  try {
    parseWebRuntimeConfig(process.env);
    return new Response('{"status":"ok"}', { status: 200, headers });
  } catch {
    return new Response(
      '{"status":"not_ready","code":"invalid_web_origin_configuration"}',
      { status: 503, headers },
    );
  }
}
