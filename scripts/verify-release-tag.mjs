import { execFileSync } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  environmentWithoutNpmCredentials,
  loadReleaseManifest,
  verifyFixtureDigests,
  verifyNpmOwnership,
  verifyReleaseGitState,
  verifyReleasePackageManifest,
} from "./release-lib.mjs";

const repository = resolve(fileURLToPath(new URL("..", import.meta.url)));
const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;
if (tag === undefined) throw new Error("Release tag argument is required");

const status = git(["status", "--porcelain"]);
const head = git(["rev-parse", "HEAD"]);
const taggedCommit = git(["rev-parse", `refs/tags/${tag}^{commit}`]);
verifyReleaseGitState(status, head, taggedCommit);

const { manifest } = await loadReleaseManifest(repository, tag);
const repositoryRealPath = await realpath(repository);
for (const item of manifest.packages) {
  const packagePath = await realpath(join(repository, item.path));
  const child = relative(repositoryRealPath, packagePath);
  if (child.length === 0 || child === ".." || child.startsWith(`..${sep}`)) {
    throw new Error(`Unsafe release package path: ${item.path}`);
  }
  const packageManifest = JSON.parse(
    await readFile(join(packagePath, "package.json"), "utf8"),
  );
  verifyReleasePackageManifest(item, packageManifest);
}

for (const schema of [
  "audit-report.v0.1.schema.json",
  "lifecycle-event.v0.1.schema.json",
  "payment-fixture.v0.1.schema.json",
  "webhook-request.v0.1.schema.json",
]) {
  await readFile(join(repository, "packages", "contracts", "schemas", schema));
}
const fixtureDirectory = join(repository, "fixtures", "v0.1");
const fixtureManifest = JSON.parse(
  await readFile(join(fixtureDirectory, "manifest.json"), "utf8"),
);
await verifyFixtureDigests(fixtureManifest, fixtureDirectory);
verifyNpmOwnership("@payops", process.env.NPM_SCOPE_OWNER);
execFileSync(
  process.execPath,
  [join(repository, "scripts", "verify-public-packages.mjs")],
  {
    cwd: repository,
    stdio: "inherit",
    env: environmentWithoutNpmCredentials(process.env),
  },
);

function git(args) {
  return execFileSync("git", args, {
    cwd: repository,
    encoding: "utf8",
  }).trim();
}
