import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const contexts = new WeakMap<FastifyRequest, { readonly requestId: string }>();

export function installRequestContext(server: FastifyInstance): void {
  server.addHook("onRequest", async (request, reply) => {
    const requested = request.headers["x-request-id"];
    const requestId =
      typeof requested === "string" && uuidPattern.test(requested)
        ? requested
        : randomUUID();
    contexts.set(request, { requestId });
    reply.header("x-request-id", requestId);
  });
}

export function requestIdFor(request: FastifyRequest): string {
  return contexts.get(request)?.requestId ?? randomUUID();
}
