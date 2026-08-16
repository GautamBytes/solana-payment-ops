import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import * as checker from "../check-hosted-self-serve.mjs";

test("accepts exact HTTPS origins", () => {
  assert.equal(
    checker.validateOrigin("https://payops.example"),
    "https://payops.example",
  );
});

test("rejects paths, credentials, and HTTP", () => {
  for (const value of [
    "http://payops.example",
    "https://payops.example/path",
    "https://user@payops.example",
  ]) {
    assert.throws(() => checker.validateOrigin(value), /invalid_hosted_origin/);
  }
});

test("exports the hosted self-serve runner", () => {
  assert.equal(typeof checker.runHostedSelfServeChecks, "function");
});

test("checks web, API, and public wallet entry points without credentials", async () => {
  const requests = [];
  const lines = [];
  const fetchImpl = async (url, init) => {
    requests.push([String(url), init]);
    return new Response(
      new URL(url).pathname === "/try"
        ? "<main>Use a public wallet</main>"
        : '{"status":"ok"}',
      { status: 200 },
    );
  };

  await checker.runHostedSelfServeChecks({
    webOrigin: "https://payops.example",
    apiOrigin: "https://api.payops.example",
    fetchImpl,
    writeLine: (line) => lines.push(line),
  });

  assert.deepEqual(
    requests.map(([url]) => url),
    [
      "https://payops.example/health/live",
      "https://payops.example/health/ready",
      "https://api.payops.example/health/live",
      "https://api.payops.example/health/ready",
      "https://payops.example/try",
    ],
  );
  assert.equal(
    requests.every(
      ([, init]) => init.redirect === "error" && init.cache === "no-store",
    ),
    true,
  );
  assert.deepEqual(lines, [
    "PASS web_live",
    "PASS web_ready",
    "PASS api_live",
    "PASS api_ready",
    "PASS try_page",
  ]);
});

test("CLI fails closed without printing missing environment values", () => {
  const script = fileURLToPath(
    new URL("../check-hosted-self-serve.mjs", import.meta.url),
  );
  const result = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^FAIL invalid_hosted_origin\n$/);
  assert.doesNotMatch(result.stderr, /undefined/);
});

test("does not expose response bodies when a hosted check fails", async () => {
  await assert.rejects(
    checker.runHostedSelfServeChecks({
      webOrigin: "https://payops.example",
      apiOrigin: "https://api.payops.example",
      fetchImpl: async () =>
        new Response("private upstream diagnostic", { status: 503 }),
      writeLine: () => {},
    }),
    (error) => {
      assert.match(
        error.message,
        /^hosted_self_serve_check_failed:web_live:status_503$/,
      );
      assert.doesNotMatch(error.message, /private|diagnostic/);
      return true;
    },
  );
});
