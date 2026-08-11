import { mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

await import("../dist/cli.js");

const directory = await mkdtemp(join(tmpdir(), "payops-pilot-bin-"));
const link = join(directory, "payops-pilot");
await symlink(new URL("../dist/bin.js", import.meta.url), link);
const result = spawnSync(process.execPath, [link], { encoding: "utf8" });
if (result.status !== 2 || !result.stderr.includes("invalid_configuration")) {
  throw new Error("payops-pilot symlinked executable did not run strictly");
}
