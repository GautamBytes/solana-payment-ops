import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const packageRoot = new URL("..", import.meta.url);
const packed = spawnSync("npm", ["pack", "--dry-run", "--json"], {
  cwd: packageRoot,
  env: { ...process.env, npm_config_cache: "/tmp/payops-npm-pack-cache" },
  encoding: "utf8",
});
assert.equal(packed.status, 0, packed.stderr);
const result = JSON.parse(packed.stdout)[0];
const paths = result.files.map((file) => file.path);
const examplePath = "src/examples/verify-consumer.ts";
assert(
  paths.includes(examplePath),
  "readable consumer implementation is packaged",
);
assert(
  !paths.some(
    (path) => path.includes("test/fixtures") || path.endsWith(".key.pem"),
  ),
  "test TLS fixtures are excluded from the package artifact",
);

const source = readFileSync(
  new URL(`../${examplePath}`, import.meta.url),
  "utf8",
);
const verification = source.indexOf("verifyWebhook(");
const parsing = source.indexOf("parse(request.rawBody)");
const deduplication = source.indexOf("processedEventIds.has(event.id)");
assert(verification >= 0, "example contains signature verification");
assert(parsing > verification, "example verifies before parsing");
assert(deduplication > parsing, "example validates before deduplication");
