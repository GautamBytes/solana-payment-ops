import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const bin = join(packageRoot, "dist/bin.js");
const temporaryDirectory = mkdtempSync(join(tmpdir(), "payops-webhooks-bin-"));
const installedBin = join(temporaryDirectory, "payops-webhooks");
chmodSync(bin, 0o755);
symlinkSync(bin, installedBin);

const result = spawnSync(installedBin, [], {
  cwd: packageRoot,
  env: { PATH: process.env.PATH },
  encoding: "utf8",
});
rmSync(temporaryDirectory, { recursive: true });

assert.equal(result.status, 2);
assert.deepEqual(JSON.parse(result.stdout), {
  error: {
    code: "invalid_configuration",
    message: "DATABASE_URL is not set",
    retryable: false,
  },
});
assert.equal(result.stderr, "");

const imported = spawnSync(
  process.execPath,
  ["--input-type=module", "--eval", 'await import("./dist/cli.js")'],
  { cwd: packageRoot, encoding: "utf8" },
);
assert.equal(imported.status, 0);
assert.equal(imported.stdout, "");
assert.equal(imported.stderr, "");
