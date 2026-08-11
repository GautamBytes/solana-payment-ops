import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

const root = resolve(import.meta.dirname, "..");
const schema = join(root, "openapi/payops-v1.json");
const output = join(root, "packages/sdk/src/generated/payops-v1.ts");
const executable = join(
  root,
  "tools/openapi-generator/node_modules/.bin/openapi-typescript",
);
const prettier = join(root, "node_modules/.bin/prettier");
const check = process.argv.slice(2).includes("--check");
const temporary = check ? await mkdtemp(join(tmpdir(), "payops-sdk-")) : null;
const target = temporary === null ? output : join(temporary, "payops-v1.ts");

try {
  const result = spawnSync(executable, [schema, "-o", target], {
    cwd: root,
    encoding: "utf8",
    stdio: check ? "pipe" : "inherit",
  });
  if (result.status !== 0) {
    if (check) process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  const formatted = spawnSync(prettier, ["--write", target], {
    cwd: root,
    encoding: "utf8",
    stdio: check ? "pipe" : "inherit",
  });
  if (formatted.status !== 0) {
    if (check) process.stderr.write(formatted.stderr);
    process.exit(formatted.status ?? 1);
  }
  if (check) {
    const [expected, generated] = await Promise.all([
      readFile(output),
      readFile(target),
    ]);
    if (!expected.equals(generated)) {
      throw new Error(
        "Generated SDK types are stale. Run `pnpm sdk:generate` and commit the result.",
      );
    }
  }
} finally {
  if (temporary !== null) await rm(temporary, { recursive: true, force: true });
}
