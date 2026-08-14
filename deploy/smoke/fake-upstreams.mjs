import { readFile } from "node:fs/promises";
import { createServer } from "node:https";

const key = await readFile(required("PAYOPS_SMOKE_TLS_KEY"));
const cert = await readFile(required("PAYOPS_SMOKE_TLS_CERT"));
const server = createServer({ key, cert }, async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    return reply(response, 200, { status: "ok" });
  }
  const body = await boundedBody(request);
  if (request.url === "/email") return reply(response, 202, { status: "ok" });
  if (request.url?.startsWith("/pyth") || request.url?.startsWith("/fx")) {
    return reply(response, 200, []);
  }
  let rpc;
  try {
    rpc = JSON.parse(body);
  } catch {
    return reply(response, 400, { error: "invalid_request" });
  }
  const result = rpcResult(rpc.method);
  return reply(response, 200, { jsonrpc: "2.0", id: rpc.id ?? null, result });
});
server.listen(443, "0.0.0.0");
const stop = () => server.close(() => (process.exitCode = 0));
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

function rpcResult(method) {
  if (method === "getSignaturesForAddress") return [];
  if (method === "getSignatureStatuses")
    return { context: { slot: 1 }, value: [] };
  if (method === "getTransaction") return null;
  if (method === "getAccountInfo") return { context: { slot: 1 }, value: null };
  if (method === "getLatestBlockhash") {
    return {
      context: { slot: 1 },
      value: {
        blockhash: "11111111111111111111111111111111",
        lastValidBlockHeight: 1,
      },
    };
  }
  return 1;
}

async function boundedBody(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 65_536) throw new Error("request_too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function reply(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

function required(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0)
    throw new Error("missing_configuration");
  return value;
}
