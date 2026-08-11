import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const repositoryDirectory = dirname(dirname(packageDirectory));
const cliPath = join(packageDirectory, "dist", "cli.js");
const fixturePath = join(
  repositoryDirectory,
  "fixtures",
  "v0.1",
  "usdc-transfer-checked-finalized.json",
);
const manifestPath = join(
  repositoryDirectory,
  "fixtures",
  "v0.1",
  "manifest.json",
);

const single = run(fixturePath);
assert.equal(single.status, 0);
assert.equal(JSON.parse(single.stdout).passed, true);

const suite = run(manifestPath);
assert.equal(suite.status, 0);
assert.equal(JSON.parse(suite.stdout).cases.length, 25);

const directory = await mkdtemp(join(tmpdir(), "payops-cli-smoke-"));
try {
  const fixture = join(directory, "fixture.json");
  await cp(fixturePath, fixture);
  const bytes = await readFile(fixture);
  const manifest = {
    schemaVersion: "0.1",
    generatedAt: "2026-08-11T00:00:00.000Z",
    cases: [
      {
        id: "expected-mismatch",
        file: "fixture.json",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        kind: "payment",
        tags: ["negative"],
        expected: {
          outcome: "verification_failure",
          eventCount: 1,
          verifiedCount: 0,
          eventIds: [
            "mainnet-beta:2Ana1pUpv2ZbMVkwF5FXapYeBEjdxDatLn7nvJkhgTSXbs59SyZSx866bXirPgj8QQVB57uxHJBG1YFvkRbFj4T:0:outer",
          ],
          verificationCodes: ["amount"],
          exceptionCode: "partial_payment",
        },
      },
    ],
  };
  const mismatchPath = join(directory, "manifest.json");
  await writeFile(mismatchPath, JSON.stringify(manifest));
  const mismatch = run(mismatchPath);
  assert.equal(mismatch.status, 1);
  assert.equal(JSON.parse(mismatch.stdout).passed, false);

  const invalidPath = join(directory, "invalid.json");
  await writeFile(invalidPath, "{");
  const invalid = run(invalidPath);
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /^Conformance error:/);
} finally {
  await rm(directory, { recursive: true, force: true });
}

function run(path) {
  return spawnSync(process.execPath, [cliPath, path], {
    encoding: "utf8",
    env: { ...process.env, INIT_CWD: undefined },
  });
}
