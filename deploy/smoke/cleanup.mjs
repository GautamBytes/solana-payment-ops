import { spawn } from "node:child_process";

const MAX_OUTPUT_BYTES = 65_536;

const project = process.argv[2];
if (
  typeof project !== "string" ||
  !/^payops-(?:ci-)?smoke(?:-[a-z0-9-]{1,48})?$/u.test(project)
) {
  throw new Error("invalid_smoke_project");
}
const ids = (
  await run(
    [
      "ps",
      "--all",
      "--quiet",
      "--filter",
      `label=com.docker.compose.project=${project}`,
    ],
    true,
  )
)
  .trim()
  .split("\n")
  .filter(Boolean);
if (ids.length > 0) await run(["rm", "--force", ...ids]);
await run(["network", "rm", `${project}_payops`], true);
await run(["volume", "rm", `${project}_postgres-data`], true);

function run(arguments_, tolerateFailure = false) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", arguments_, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    child.stdout.on("data", (chunk) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendBounded(stderr, chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0 || tolerateFailure) resolve(stdout.toString("utf8"));
      else
        reject(
          new Error(
            `smoke_cleanup_failed:${stderr.subarray(-1_000).toString("utf8")}`,
          ),
        );
    });
  });
}

function appendBounded(current, chunk) {
  if (current.length >= MAX_OUTPUT_BYTES) return current;
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  return Buffer.concat([
    current,
    bytes.subarray(0, MAX_OUTPUT_BYTES - current.length),
  ]);
}
