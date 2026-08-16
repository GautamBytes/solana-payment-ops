import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { PLATFORM_MIGRATION_NAMES } from "../src/index.js";

describe("public analysis rate-limit boundary", () => {
  it("registers a non-tenant bucket containing digested scopes only", async () => {
    const sql = await readFile(
      new URL(
        "../migrations/4016_public_analysis_rate_limits.sql",
        import.meta.url,
      ),
      "utf8",
    );

    expect(PLATFORM_MIGRATION_NAMES.at(-1)).toBe(
      "4016_public_analysis_rate_limits",
    );
    expect(sql).toContain("CREATE TABLE public_analysis_rate_limit_buckets");
    expect(sql).toContain("scope_digest text");
    expect(sql).toContain("scope_digest ~ '^[0-9a-f]{64}$'");
    expect(sql).not.toMatch(/wallet|ip_address|remote_address/);
  });
});
