import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));

test("keeps explicit rate-limit coverage for every CodeQL route group", async () => {
  const sources = Object.fromEntries(
    await Promise.all(
      [
        "apps/api/src/routes/customers.ts",
        "apps/api/src/routes/merchant-wallets.ts",
        "apps/api/src/routes/invoices.ts",
        "apps/api/src/routes/operations.ts",
        "apps/api/src/routes/operational-health.ts",
        "apps/api/src/routes/public-checkout.ts",
        "apps/api/src/routes/bootstrap-acceptance.ts",
        "apps/api/src/server.ts",
      ].map(async (path) => [path, await readFile(`${root}${path}`, "utf8")]),
    ),
  );

  assert.equal(
    occurrences(
      sources["apps/api/src/routes/customers.ts"],
      "!(await consume(",
    ),
    3,
  );
  assert.equal(
    occurrences(
      sources["apps/api/src/routes/merchant-wallets.ts"],
      "!(await consumeRateLimit(",
    ),
    5,
  );
  assert.equal(
    occurrences(sources["apps/api/src/routes/invoices.ts"], "!(await consume("),
    5,
  );
  assert.equal(
    occurrences(
      sources["apps/api/src/routes/operations.ts"],
      "!(await consume(",
    ),
    10,
  );
  assert.equal(
    occurrences(
      sources["apps/api/src/routes/operational-health.ts"],
      "const actor = await reader(",
    ),
    4,
  );
  assert.equal(
    occurrences(
      sources["apps/api/src/routes/operational-health.ts"],
      "const actor = await operator(",
    ),
    2,
  );
  assert.equal(
    occurrences(
      sources["apps/api/src/routes/operational-health.ts"],
      "const actor = await owner(",
    ),
    1,
  );
  assert.equal(
    occurrences(
      sources["apps/api/src/routes/operational-health.ts"],
      "!(await consume(",
    ),
    3,
  );
  assert.equal(
    occurrences(
      sources["apps/api/src/routes/public-checkout.ts"],
      "!(await consumeMerchant(",
    ),
    2,
  );
  assert.equal(
    occurrences(
      sources["apps/api/src/routes/public-checkout.ts"],
      "!(await consumePublic(",
    ),
    3,
  );
  assert.match(
    sources["apps/api/src/server.ts"],
    /const rateLimit = await rateLimits\.consume\(/,
  );
  assert.match(
    sources["apps/api/src/server.ts"],
    /registerBootstrapAcceptanceRoute\(server/,
  );

  const bootstrap = sources["apps/api/src/routes/bootstrap-acceptance.ts"];
  assert.ok(
    bootstrap.indexOf("await consumeRateLimit(") <
      bootstrap.indexOf("dependencies.hashPassword("),
    "bootstrap limiting must happen before password hashing",
  );
  assert.match(bootstrap, /await dependencies\.rateLimits\.consume\(/);
});

test("records the reviewed CodeQL findings and durable controls", async () => {
  const evidence = await readFile(
    `${root}docs/security/rate-limit-control-evidence.md`,
    "utf8",
  );
  for (const marker of [
    "CodeQL alerts 1-33",
    "api_rate_limit_buckets",
    "public_analysis_rate_limit_buckets",
    "bootstrap-acceptance",
    "fail closed",
  ]) {
    assert.match(evidence, new RegExp(marker));
  }
});

function occurrences(source, needle) {
  return source.split(needle).length - 1;
}
