const headers = {
  "cache-control": "no-store",
  "content-type": "application/json",
} as const;

export function GET(): Response {
  return new Response('{"status":"ok"}', { status: 200, headers });
}
