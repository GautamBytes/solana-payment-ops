import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sdk = await import("@payops/sdk");
if (
  typeof sdk.createPayOpsClient !== "function" ||
  typeof sdk.PayOpsApiError !== "function"
) {
  throw new Error("@payops/sdk native ESM exports are unavailable");
}

const cache = await mkdtemp(join(tmpdir(), "payops-sdk-pack-"));
let manifest;
try {
  const packed = spawnSync(
    "npm",
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
      env: { ...process.env, npm_config_cache: cache },
    },
  );
  if (packed.status !== 0)
    throw new Error(packed.stderr || "npm pack dry run failed");
  manifest = JSON.parse(packed.stdout)[0];
} finally {
  await rm(cache, { recursive: true, force: true });
}
const files = manifest.files.map((entry) => entry.path).sort();
for (const required of [
  "LICENSE",
  "README.md",
  "dist/client.d.ts",
  "dist/client.js",
  "dist/generated/payops-v1.d.ts",
  "dist/index.d.ts",
  "dist/index.js",
  "package.json",
]) {
  if (!files.includes(required))
    throw new Error(`published SDK is missing ${required}`);
}
for (const file of files) {
  if (/\b(src|test|migrations|\.env|\.superpowers)\b/u.test(file)) {
    throw new Error(`private SDK artifact leaked: ${file}`);
  }
}
