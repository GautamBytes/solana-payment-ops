import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const before = process.listenerCount("SIGTERM");
const worker = await import("@payops/worker");
if (typeof worker.runWorker !== "function") {
  throw new Error("@payops/worker runner export is unavailable");
}
if (process.listenerCount("SIGTERM") !== before) {
  throw new Error("importing @payops/worker registered process listeners");
}

const binPath = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
const missingConfig = spawnSync(process.execPath, [binPath], {
  encoding: "utf8",
  env: {},
});
if (
  missingConfig.status !== 1 ||
  missingConfig.stdout !== "" ||
  missingConfig.stderr !== "missing_configuration\n"
) {
  throw new Error("Worker binary did not reject missing configuration safely");
}
