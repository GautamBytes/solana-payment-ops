import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { installErrorHandler, ApiError } from "../src/protocol/api-error.js";
import {
  cursorFilterDigest,
  decodeCursor,
  encodeCursor,
  parseLimit,
} from "../src/protocol/cursor.js";
import { installRequestContext } from "../src/protocol/request-context.js";

describe("API protocol", () => {
  it("binds a canonical request ID and emits stable bounded errors", async () => {
    const server = Fastify({ bodyLimit: 256 * 1_024 });
    installRequestContext(server);
    installErrorHandler(server);
    server.post("/known", async () => {
      throw new ApiError(409, "known_conflict", "Known conflict", {
        field: "name",
      });
    });
    server.post("/unknown", async () => {
      throw new Proxy(
        {},
        {
          getPrototypeOf: () => {
            throw new Error("secret prototype");
          },
          getOwnPropertyDescriptor: () => {
            throw new Error("secret");
          },
        },
      );
    });
    try {
      const requestId = randomUUID();
      const known = await server.inject({
        method: "POST",
        url: "/known",
        headers: {
          "x-request-id": requestId,
          "content-type": "application/json",
        },
        payload: {},
      });
      expect(known.headers["x-request-id"]).toBe(requestId);
      expect(known.json()).toEqual({
        code: "known_conflict",
        message: "Known conflict",
        requestId,
        details: { field: "name" },
      });

      const malformed = await server.inject({
        method: "POST",
        url: "/unknown",
        headers: {
          "x-request-id": "not-a-uuid",
          "content-type": "application/json",
        },
        payload: {},
      });
      expect(malformed.statusCode).toBe(500);
      expect(malformed.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
      expect(malformed.body).not.toContain("secret");
    } finally {
      await server.close();
    }
  });

  it("binds opaque cursors to endpoint, organization, sort, and filters", () => {
    const filterDigest = cursorFilterDigest({
      endpoint: "customers.list",
      organizationId: randomUUID(),
      sort: "created_desc",
      filters: { externalId: null },
    });
    const position = {
      createdAt: "2026-08-12T00:00:00.000Z",
      id: randomUUID(),
    };
    const cursor = encodeCursor(position, filterDigest);
    expect(decodeCursor(cursor, filterDigest)).toEqual(position);
    expect(() => decodeCursor(cursor, "a".repeat(64))).toThrowError(
      expect.objectContaining({ code: "invalid_cursor" }),
    );
    expect(() => decodeCursor("A".repeat(1_025), filterDigest)).toThrowError(
      expect.objectContaining({ code: "invalid_cursor" }),
    );
    expect(parseLimit(undefined)).toBe(50);
    expect(parseLimit("100")).toBe(100);
    for (const value of ["0", "101", "01", "1.5", ["1", "2"]]) {
      expect(() => parseLimit(value)).toThrowError(
        expect.objectContaining({ code: "invalid_cursor" }),
      );
    }
  });
});
