import { execFileSync, spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../", import.meta.url));
const targets = Object.freeze([
  "payops-api",
  "payops-worker",
  "payops-web",
  "payops-migrate",
]);

export function parseBuildRevision(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/u.test(value)) {
    throw new Error("invalid_build_revision");
  }
  return value;
}

export function assertCleanRepository(status) {
  if (status !== "") {
    throw new Error("container_build_requires_clean_checkout");
  }
}

export function buildArguments(target, revision) {
  if (!targets.includes(target)) throw new Error("invalid_container_target");
  return [
    "buildx",
    "build",
    "--load",
    "--target",
    target,
    "--build-arg",
    `PAYOPS_BUILD_REVISION=${parseBuildRevision(revision)}`,
    "-t",
    `${target}:local`,
    ".",
  ];
}

export async function buildContainers() {
  assertCleanRepository(
    execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
      cwd: repository,
      encoding: "utf8",
      maxBuffer: 1_048_576,
      stdio: ["ignore", "pipe", "ignore"],
    }),
  );
  const revision = parseBuildRevision(
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repository,
      encoding: "utf8",
      maxBuffer: 128,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim(),
  );
  for (const target of targets) {
    await runDocker(buildArguments(target, revision));
  }
}

if (isMainModule()) await buildContainers();

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

function runDocker(arguments_) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", arguments_, {
      cwd: repository,
      stdio: "inherit",
    });
    child.once("error", () => reject(new Error("container_build_failed")));
    child.once("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`container_build_failed_${code ?? "signal"}`)),
    );
  });
}
