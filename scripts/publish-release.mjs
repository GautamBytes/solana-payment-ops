import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadReleaseManifest,
  preflightReleasePublication,
  sha512Integrity,
  verifyNpmOwnership,
  verifyReleaseGitState,
} from "./release-lib.mjs";

const repository = resolve(fileURLToPath(new URL("..", import.meta.url)));
const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;
if (tag === undefined) throw new Error("Release tag argument is required");
const trackedStatus = execFileSync(
  "git",
  ["status", "--porcelain", "--untracked-files=no"],
  { cwd: repository, encoding: "utf8" },
).trim();
const head = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repository,
  encoding: "utf8",
}).trim();
const taggedCommit = execFileSync(
  "git",
  ["rev-parse", `refs/tags/${tag}^{commit}`],
  { cwd: repository, encoding: "utf8" },
).trim();
verifyReleaseGitState(trackedStatus, head, taggedCommit);
verifyNpmOwnership("@payops", process.env.NPM_SCOPE_OWNER);
const { manifest } = await loadReleaseManifest(repository, tag);
const directory = await mkdtemp(join(tmpdir(), "payops-publish-"));

try {
  const artifacts = [];
  for (const item of manifest.packages) {
    const output = execFileSync(
      "pnpm",
      [
        "--dir",
        join(repository, item.path),
        "pack",
        "--json",
        "--pack-destination",
        directory,
      ],
      { encoding: "utf8", env: { ...process.env, CI: "true" } },
    );
    const packed = JSON.parse(output);
    const tarball = resolve(directory, packed.filename);
    const integrity = sha512Integrity(await readFile(tarball));
    artifacts.push({ ...item, tarball, integrity });
  }

  const publicationPlan = preflightReleasePublication(
    artifacts,
    ({ name, version }) =>
      spawnSync(
        "npm",
        ["view", `${name}@${version}`, "dist.integrity", "--json"],
        { encoding: "utf8" },
      ),
  );

  for (const { name, version, tarball, publication } of publicationPlan) {
    if (publication === "already-published") {
      process.stdout.write(
        `${name}@${version} already published with matching bytes\n`,
      );
      continue;
    }
    execFileSync(
      "npm",
      ["publish", tarball, "--access", "public", "--provenance"],
      { cwd: repository, stdio: "inherit" },
    );
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
