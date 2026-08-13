import {
  canonicalJson,
  completeIdempotency,
  digestIdempotentRequest,
  type IdempotencyStore,
  type IdempotencyResponseCommitter,
  type OrganizationDatabase,
} from "@payops/platform";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { RequestActor } from "../auth/context.js";
import { errorBody } from "./api-error.js";

export interface IdempotentRouteResult {
  readonly status: number;
  readonly body: unknown;
  readonly idempotencyCompleted?: true;
  readonly idempotencyRetryable?: true;
}

export class IdempotentRouteExecutor {
  readonly #store: IdempotencyStore;
  readonly #database: OrganizationDatabase;

  public constructor(store: IdempotencyStore, database: OrganizationDatabase) {
    this.#store = store;
    this.#database = database;
  }

  public async execute(
    request: FastifyRequest,
    reply: FastifyReply,
    actor: RequestActor,
    routeId: string,
    path: Readonly<Record<string, string>>,
    body: unknown,
    operation: (
      committer: IdempotencyResponseCommitter,
    ) => Promise<IdempotentRouteResult>,
  ): Promise<FastifyReply> {
    const key = request.headers["idempotency-key"];
    if (
      typeof key !== "string" ||
      key.length < 16 ||
      key.length > 128 ||
      !/^[\x21-\x7e]+$/.test(key)
    ) {
      return reply
        .code(400)
        .send(
          errorBody(
            request,
            "invalid_idempotency_key",
            "A valid Idempotency-Key is required",
          ),
        );
    }
    const requestDigest = digestIdempotentRequest({
      method: request.method.toUpperCase(),
      routeId,
      path,
      body,
    });
    const claim = await this.#store.claim(
      {
        organizationId: actor.organizationId,
        actorKind: actor.kind,
        actorId: actor.actorId,
        routeId,
        key,
        requestDigest,
      },
      new Date(),
    );
    if (claim.kind === "conflict") {
      return reply
        .code(409)
        .send(
          errorBody(
            request,
            "idempotency_conflict",
            "Idempotency key was already used for another request",
          ),
        );
    }
    if (claim.kind === "in_progress") {
      return reply
        .code(409)
        .send(
          errorBody(
            request,
            "idempotency_in_progress",
            "An equivalent request is still in progress",
          ),
        );
    }
    if (claim.kind === "replay") {
      return reply
        .code(claim.status)
        .type(claim.contentType)
        .send(Buffer.from(claim.body));
    }

    const committer: IdempotencyResponseCommitter = {
      complete: async (transaction, status, body) => {
        await completeIdempotency(transaction, {
          organizationId: actor.organizationId,
          recordId: claim.recordId,
          leaseToken: claim.leaseToken,
          status,
          contentType: "application/json; charset=utf-8",
          body: Buffer.from(canonicalJson(body), "utf8"),
          completedAt: new Date(),
        });
      },
    };
    const result = await operation(committer);
    const responseBody = Buffer.from(canonicalJson(result.body), "utf8");
    const contentType = "application/json; charset=utf-8";
    if (
      result.idempotencyCompleted !== true &&
      result.idempotencyRetryable !== true
    ) {
      await this.#database.transaction(
        { organizationId: actor.organizationId, actorId: actor.actorId },
        async (transaction) => {
          await completeIdempotency(transaction, {
            organizationId: actor.organizationId,
            recordId: claim.recordId,
            leaseToken: claim.leaseToken,
            status: result.status,
            contentType,
            body: responseBody,
            completedAt: new Date(),
          });
        },
      );
    }
    return reply.code(result.status).type(contentType).send(responseBody);
  }
}
